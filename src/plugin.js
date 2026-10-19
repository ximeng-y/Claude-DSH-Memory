/**
 * Host wiring: the only module that touches `ctx`.
 *
 * Hard rules learned the hard way (a bug here crashed the desktop app):
 *
 * 1. **Never** read an optional service as a property (`ctx.workingDirectory`):
 *    Cordis throws unless the service is listed in `inject`. Read it through
 *    `ctx.get(name)` inside {@link safe}.
 * 2. **Never** let a listener throw or leak a rejected promise. A serial
 *    listener can fail agent creation, and an unhandled rejection can take the
 *    whole app down (the turn/end path is fire-and-forget, so it must `.catch`).
 * 3. **Never** let the write guard throw: a throwing guard denies every tool
 *    call and locks the session out. It fails open and logs.
 *
 * Registration order: tools → write guard → baseline injection → intent
 * reminder → direct-write marks → turn texts → extraction worker.
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { CODES, MemoryError, asMemoryError } from './errors.js'
import { isExcludedProject, resolveConfig } from './config.js'
import { buildBaseline, buildDiagnosis, buildInjectionMessage, SOURCE_KIND } from './inject.js'
import { detectIntent, reminderText, userMessageText } from './intent.js'
import { buildWriteGuard, denyMessage, isPathInsideRoot } from './guard.js'
import { slugForPath } from './paths.js'
import { MemoryRuntime } from './runtime.js'
import { createMemoryTools } from './tools.js'
import {
  buildPrompt,
  enqueueSnapshot,
  extractJson,
  publishOperations,
  readLastDigest,
  saveReview,
  snapshotDigest,
  snapshotId,
  validateOperations,
  writeLastDigest,
} from './extract.js'
import { FileLogger, clip } from './util.js'

const WRITE_TOOLS = new Set(['claude_memory_write', 'claude_memory_forget', 'claude_memory_repair_index'])
const ASSISTANT_TEXT_LIMIT = 20_000
const USER_TEXT_LIMIT = 12_000
const MANIFEST_LIMIT = 200
const REMINDER_COOLDOWN_MS = 60_000

/**
 * Run a value-producing callback, swallowing any exception.
 *
 * @template T
 * @param {() => T} operation
 * @param {T} fallback
 * @returns {T}
 */
function safe(operation, fallback) {
  try {
    return operation()
  } catch {
    return fallback
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const { config, warnings, problems } = resolveConfig(rawConfig)
  if (!config.enabled) return

  const logger = new FileLogger({
    file: path.join(config.stateRoot, 'logs', 'plugin.log'),
    level: config.logLevel,
    sink: (line) => {
      safe(() => ctx.logger?.info?.(line), undefined)
    },
  })
  const runtime = new MemoryRuntime({ config, warnings, problems, env: process.env, logger })
  if (problems.length > 0) logger.error('config problems', problems.join('; '))

  /** @type {Map<string, { user: string[], assistant: string, turn: number }>} */
  const turnBuffers = new Map()
  /** @type {Map<string, Set<number>>} */
  const maintainedTurns = new Map()
  /** @type {Map<string, number>} */
  const reminderTimes = new Map()
  /** @type {Set<string>} */
  const knownRoots = new Set()

  /**
   * Optional-service lookup. `ctx.get()` is the documented optional access and
   * never throws; every other access path can.
   *
   * @param {string} name
   * @returns {any}
   */
  const service = (name) => safe(() => ctx.get?.(name), null) ?? null

  /**
   * @param {unknown} error
   * @returns {string}
   */
  const describe = (error) => (error instanceof Error ? error.message : String(error))

  /**
   * The executing agent. `exec.agent` is only populated on some call paths, so
   * fall back to the initiator the Host carries through the driver chain.
   *
   * @param {{ agent?: { id: string } } | undefined} exec
   * @returns {{ id: string } | null}
   */
  const agentOf = (exec) => {
    if (exec?.agent?.id) return exec.agent
    return safe(() => service('agents')?.currentInitiator?.() ?? null, null)
  }

  /**
   * @param {{ id: string } | null | undefined} agent
   * @returns {string | null}
   */
  const cwdOf = (agent) => {
    const id = agent?.id
    if (!id) return null
    const session = safe(() => service('sessions')?.get?.(id) ?? null, null)
    if (!session) return null
    return safe(() => service('workingDirectory')?.get?.(session) ?? null, null)
  }

  /**
   * @param {{ agent?: { id: string } } | undefined} exec
   * @returns {string}
   */
  const cwdFor = (exec) => {
    const cwd = cwdOf(agentOf(exec))
    if (cwd) return cwd
    const fallback = safe(() => service('workingDirectory')?.defaultDirectory ?? null, null)
    if (typeof fallback === 'string' && fallback) return fallback
    throw new MemoryError(CODES.NO_SESSION, '拿不到当前会话的工作目录；请在会话内调用这些工具')
  }

  /** @param {string} dir */
  const remember = (dir) => {
    knownRoots.add(dir)
    knownRoots.add(path.join(dir, 'MEMORY.md'))
  }

  // Explicit mappings are protected before any session resolves them.
  for (const [, dir] of config.projectMemoryDirs) remember(dir)

  /**
   * Roots the guard protects for one working directory: everything already
   * resolved, every explicit mapping on the path, and the slug guess. Extra
   * entries only make the guard stricter.
   *
   * @param {string | null} cwd
   * @returns {string[]}
   */
  const rootsFor = (cwd) => {
    /** @type {string[]} */
    const roots = [...knownRoots]
    if (cwd) {
      const resolved = path.resolve(cwd)
      for (const [projectPath, memoryDir] of config.projectMemoryDirs) {
        if (isPathInsideRoot(projectPath, resolved)) roots.push(memoryDir)
      }
      roots.push(path.join(config.claudeConfigDir, 'projects', slugForPath(resolved), 'memory'))
    }
    return roots
  }

  try {
    registerTools()
    registerGuard()
    registerBaseline()
    registerIntentReminder()
    registerMaintenanceMarks()
    registerTurnTexts()
    registerExtraction()
  } catch (error) {
    logger.error('plugin setup failed', describe(error))
  }

  // One audit line per mount: enough to tell which config actually took effect.
  logger.info(
    'claude-dsh-memory ready',
    `guard=${config.guardEnabled ? 'on' : 'off'}`,
    `baseline=${config.injectBaseline ? 'on' : 'off'}`,
    `extract=${config.autoExtract ? 'on' : 'off'}`,
    `intent=${config.intentReminder}`,
    `minUserChars=${config.extract.minUserChars}`,
    `memory=${config.projectMemoryDirs.size > 0 ? `${config.projectMemoryDirs.size} mapping(s)` : 'slug'}`,
  )

  // ------------------------------------------------------------------ pieces

  function registerTools() {
    const tools = createMemoryTools({ runtime, cwdFor })
    for (const definition of tools) {
      try {
        const dispose = ctx.tools.register(/** @type {never} */ (definition))
        safe(() => ctx.effect(() => dispose), undefined)
      } catch (error) {
        logger.error('tool registration failed', describe(error), definition?.name ?? '')
      }
    }
  }

  function registerGuard() {
    if (!config.guardEnabled) return
    const guard = buildWriteGuard({
      enabled: () => config.guardEnabled,
      cwdFor: (agent) => cwdOf(/** @type {{ id: string } | null} */ (agent)),
      isProtectedPath: (absolute, cwd) => rootsFor(cwd).some((root) => isPathInsideRoot(root, absolute)),
      protectedPaths: (cwd) => rootsFor(cwd).filter((root) => !root.toLowerCase().endsWith('memory.md')),
      onDeny: (details) => {
        runtime.counters.guard.denied += 1
        logger.info('denied direct write', details.toolName, details.target ?? '')
      },
      message: denyMessage,
    })
    const dispose = ctx.tools.guard((exec) => {
      // Fail open: a broken guard must never be able to lock every tool out.
      try {
        return guard({ name: exec?.name, arguments: exec?.arguments, agent: agentOf(exec) })
      } catch (error) {
        logger.error('guard failed (fail-open)', describe(error))
        return undefined
      }
    })
    safe(() => ctx.effect(() => dispose), undefined)
  }

  function registerBaseline() {
    if (config.injectBaseline !== true) return
    ctx.on('agent/created', async (payload) => {
      try {
        await injectBaseline(payload)
      } catch (error) {
        logger.error('baseline injection failed', describe(error))
      }
    })
  }

  /** @param {{ agent?: { id: string, session?: any }, source?: string } | undefined} payload */
  async function injectBaseline(payload) {
    const agent = payload?.agent
    if (!agent?.id) return
    const session = safe(() => agent.session, null) ?? safe(() => service('sessions')?.get?.(agent.id), null)
    if (!session) return
    if (safe(() => session.header?.origin, undefined) === 'subagent') return
    if (payload?.source === 'resume' && alreadyInjected(session)) return

    const cwd = cwdOf(agent)
    if (!cwd) return

    let text
    try {
      const { store, resolved } = await runtime.store(cwd)
      remember(resolved.dir)
      const formatted = await store.formattedIndex()
      text = buildBaseline({
        memoryDir: resolved.dir,
        unconfirmed: !resolved.confirmed,
        indexText: formatted.text,
        indexTruncated: formatted.truncated,
        extractionNote: config.autoExtract,
        guardEnabled: config.guardEnabled,
        warnings: runtime.warnings,
        maxChars: config.injectMaxChars,
      })
      logger.debug('baseline injected', resolved.dir)
    } catch (error) {
      const typed = asMemoryError(error)
      text = buildDiagnosis(`${typed.code}：${typed.message}`)
      logger.debug('baseline diagnosis', typed.code)
    }

    agent.inject(buildInjectionMessage(text, randomUUID()))
  }

  function registerIntentReminder() {
    if (config.intentReminder === 'off') return
    if (config.intentReminder === 'claimed') {
      ctx.on('agent/inbox/claimed', (payload) => {
        try {
          const sessionId = payload?.agent?.id
          const intent = detectIntent(userMessageText(payload?.message))
          if (!sessionId || intent === null || cooling(sessionId, intent.kind)) return
          payload.agent.inject({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: reminderText(intent, { hasIndex: knownRoots.size > 0 }) }],
            source: { kind: SOURCE_KIND, form: 'intent-reminder' },
          })
        } catch (error) {
          logger.error('inbox reminder failed', describe(error))
        }
      })
      return
    }

    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (config.intentReminder !== 'pre-step') return decision
        if (decision?.kind !== 'enter') return decision
        const sessionId = payload?.agent?.id
        if (!sessionId) return decision
        const incoming = Array.isArray(decision.messages) ? decision.messages : []
        const text = incoming
          .filter((message) => message?.role === 'user' && message?.source?.kind !== SOURCE_KIND)
          .map((message) => userMessageText(message))
          .join('\n')
        const intent = detectIntent(text)
        if (intent === null || cooling(sessionId, intent.kind)) return decision

        let hasIndex = false
        try {
          const cwd = cwdOf(payload.agent)
          if (cwd) {
            const { store } = await runtime.store(cwd)
            hasIndex = (await store.readIndexText()).trim().length > 0
          }
        } catch {
          hasIndex = false
        }
        const reminder = {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: reminderText(intent, { hasIndex }) }],
          source: { kind: SOURCE_KIND, form: 'intent-reminder' },
        }
        return { ...decision, messages: [...decision.messages, reminder] }
      } catch (error) {
        logger.error('pre-step reminder failed', describe(error))
        return decision
      }
    })
  }

  /**
   * @param {string} sessionId
   * @param {string} kind
   * @returns {boolean} true when a reminder was already injected recently.
   */
  function cooling(sessionId, kind) {
    const key = `${sessionId}|${kind}`
    const now = Date.now()
    if (now - (reminderTimes.get(key) ?? 0) < REMINDER_COOLDOWN_MS) return true
    reminderTimes.set(key, now)
    return false
  }

  function registerMaintenanceMarks() {
    ctx.on('tools/result', (exec, result) => {
      try {
        const name = exec?.name
        if (!WRITE_TOOLS.has(name)) return
        if (result?.isError === true) return
        if (name === 'claude_memory_repair_index') {
          const args = /** @type {Record<string, unknown>} */ (exec?.arguments ?? {})
          if (args.dryRun !== false) return
        }
        const sessionId = agentOf(exec)?.id
        if (!sessionId) return
        const turn = turnBuffers.get(sessionId)?.turn ?? 0
        const set = maintainedTurns.get(sessionId) ?? new Set()
        set.add(turn)
        maintainedTurns.set(sessionId, set)
      } catch (error) {
        logger.error('tools/result listener failed', describe(error))
      }
    })
    ctx.on('agent/disposed', (payload) => {
      try {
        const id = payload?.agent?.id
        if (!id) return
        turnBuffers.delete(id)
        maintainedTurns.delete(id)
      } catch {
        /* ignore */
      }
    })
  }

  function registerTurnTexts() {
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = session?.id
        if (!sessionId || !event) return
        switch (event.type) {
          case 'turn/start':
            turnBuffers.set(sessionId, { user: [], assistant: '', turn: event.data?.turn ?? 0 })
            return
          case 'user/message': {
            const message = event.data
            if (message?.source?.kind === SOURCE_KIND) return
            const buffer = turnBuffers.get(sessionId)
            if (!buffer) return
            const text = userMessageText(message).trim()
            if (text) buffer.user.push(text)
            return
          }
          case 'assistant/message': {
            const buffer = turnBuffers.get(sessionId)
            if (!buffer) return
            const text = messageText(event.data?.message)
            if (text) buffer.assistant = text
            return
          }
          case 'turn/end': {
            const buffer = turnBuffers.get(sessionId)
            turnBuffers.delete(sessionId)
            const turn = event.data?.turn ?? buffer?.turn ?? 0
            const reason = event.data?.reason?.kind
            // Fire-and-forget, but the rejection must be handled: an unhandled
            // rejection here terminates the desktop app.
            maybeEnqueue({ sessionId, turn, reason, buffer }).catch((error) => {
              logger.error('extraction enqueue failed', describe(error))
            })
            return
          }
          default:
            return
        }
      } catch (error) {
        logger.error('session/event listener failed', describe(error))
      }
    })
  }

  function registerExtraction() {
    ctx.effect(() => () => {
      disposed = true
      pending.length = 0
    })
  }

  // --------------------------------------------------------------- extraction
  /** @type {Array<{ snapshot: import('./extract.js').ExtractionSnapshot, cwd: string }>} */
  const pending = []
  let workerActive = false
  let disposed = false

  async function pump() {
    if (workerActive || disposed) return
    workerActive = true
    try {
      while (pending.length > 0 && !disposed) {
        const job = /** @type {{ snapshot: import('./extract.js').ExtractionSnapshot, cwd: string }} */ (pending.shift())
        await runExtraction(job)
      }
    } finally {
      workerActive = false
    }
  }

  /**
   * @param {{ sessionId: string, turn: number, reason: string | undefined, buffer: { user: string[], assistant: string, turn: number } | undefined }} input
   */
  async function maybeEnqueue(input) {
    const counters = runtime.counters
    try {
      const { sessionId, turn, reason, buffer } = input
      if (config.autoExtract !== true) return counters.countExtract('skipped')
      if (reason !== 'completed') return counters.countExtract('skipped')
      if (buffer === undefined) return counters.countExtract('skipped')
      const userText = buffer.user.join('\n\n').trim()
      if (userText.length < config.extract.minUserChars) return counters.countExtract('skipped')
      if (maintainedTurns.get(sessionId)?.has(turn) === true) return counters.countExtract('skipped')

      const cwd = cwdOf({ id: sessionId })
      if (!cwd) return counters.countExtract('skipped')
      if (isExcludedProject(cwd, config.extract.excludeProjects)) return counters.countExtract('skipped')

      const { store, resolved } = await runtime.store(cwd)
      remember(resolved.dir)
      const manifest = await store.manifest({ limit: MANIFEST_LIMIT })
      const dirFingerprint = await store.dirFingerprint()
      const snapshot = {
        id: snapshotId(sessionId, turn),
        sessionId,
        turn,
        cwd,
        memoryDir: resolved.dir,
        capturedAt: new Date().toISOString(),
        userText: clip(userText, USER_TEXT_LIMIT),
        assistantText: clip(buffer.assistant, ASSISTANT_TEXT_LIMIT),
        manifest: manifest.entries.map((entry) => ({
          filename: entry.filename,
          name: entry.name,
          description: entry.description,
          type: entry.type,
        })),
        dirFingerprint,
      }
      const state = runtime.stateFor(resolved.dir)
      if ((await readLastDigest(state)) === snapshotDigest(snapshot)) return counters.countExtract('skipped')
      if (!hasExtractionRoute()) return counters.countExtract('skipped')

      await enqueueSnapshot(state, snapshot)
      counters.extract.queued += 1
      pending.push({ snapshot, cwd })
      await pump()
    } catch (error) {
      const typed = asMemoryError(error)
      counters.countExtract('skipped')
      counters.recordError({ code: typed.code, message: typed.message })
      logger.error('extraction enqueue failed', typed.code, typed.message)
    }
  }

  /** @returns {boolean} */
  function hasExtractionRoute() {
    return currentRoute() !== null
  }

  /** @returns {{ provider: string, model: string } | null} */
  function currentRoute() {
    if (config.extract.provider && config.extract.model) {
      return { provider: config.extract.provider, model: config.extract.model }
    }
    const selection = safe(() => service('agentDefaultModel')?.currentSelection?.() ?? null, null)
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
    return null
  }

  /**
   * @param {{ snapshot: import('./extract.js').ExtractionSnapshot, cwd: string }} job
   */
  async function runExtraction(job) {
    const { snapshot, cwd } = job
    const counters = runtime.counters
    counters.extract.running += 1
    counters.extract.queued = Math.max(0, counters.extract.queued - 1)
    const state = runtime.stateFor(snapshot.memoryDir)
    try {
      const route = currentRoute()
      if (route === null) throw new MemoryError(CODES.EXTRACT_ROUTE_MISSING, '没有可用的 provider/model，无法做后台提取')
      const llm = service('llm')
      if (!llm?.stream) throw new MemoryError(CODES.EXTRACT_ROUTE_MISSING, '当前 profile 没有 llm 服务，无法做后台提取')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.extract.timeoutMs)
      let text = ''
      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(snapshot) }] }],
          signal: controller.signal,
          sessionId: snapshot.sessionId,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += chunk.text ?? ''
        }
      } finally {
        clearTimeout(timer)
      }
      if (text.trim() === '') {
        throw new MemoryError(CODES.EXTRACT_PARSE, '模型没有返回任何内容，本轮提取放弃')
      }

      const parsed = extractJson(text)
      const { store: readStore } = await runtime.store(cwd)
      const manifest = await readStore.manifest({ limit: MANIFEST_LIMIT })
      const operations = validateOperations(parsed, {
        manifest: manifest.entries,
        maxOperations: config.extract.maxOperations,
        maxBodyBytes: config.extract.maxBodyBytes,
      })
      if (operations.length === 0) {
        // A run that produced nothing is still a run: log it so support can
        // tell "model found nothing" apart from "never called".
        counters.countExtract('skipped')
        logger.info('extraction ran: no operations', snapshot.id)
        await writeLastDigest(state, snapshotDigest(snapshot))
        await removeQueueFile(state, snapshot.id)
        return
      }
      const store = await runtime.writableStore(cwd)
      const result = await publishOperations({ store, state, snapshot, operations })
      await writeLastDigest(state, snapshotDigest(snapshot))
      await removeQueueFile(state, snapshot.id)
      if (result.status === 'ok') {
        counters.countExtract('succeeded')
        logger.info('extraction applied', `${result.applied.length} operations`)
      } else if (result.status === 'stale') {
        counters.countExtract('failed')
        logger.info('extraction abandoned: memory changed while extracting')
      } else {
        counters.countExtract('failed')
        counters.recordError(result.error ?? { code: CODES.INTERNAL, message: 'partial' })
        logger.error('extraction partial', result.error?.code ?? '')
      }
    } catch (error) {
      const typed = asMemoryError(error)
      counters.countExtract('failed')
      counters.recordError({ code: typed.code, message: typed.message })
      logger.error('extraction failed', typed.code, typed.message)
      try {
        await saveReview(state, snapshot, [], { kind: 'failed', error: typed.toJSON() })
        await removeQueueFile(state, snapshot.id)
      } catch {
        /* diagnostics only */
      }
    } finally {
      counters.extract.running = Math.max(0, counters.extract.running - 1)
    }
  }

  /**
   * @param {import('./state.js').ProjectState} state
   * @param {string} id
   */
  async function removeQueueFile(state, id) {
    await fsp.rm(state.file('queue', `${id}.json`), { force: true }).catch(() => {})
  }
}

/**
 * @param {any} session
 * @returns {boolean}
 */
function alreadyInjected(session) {
  try {
    const messages = session.deriveMessages?.() ?? []
    return messages.some((message) => message?.source?.kind === SOURCE_KIND)
  } catch {
    return false
  }
}

/**
 * @param {any} message
 * @returns {string}
 */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}
