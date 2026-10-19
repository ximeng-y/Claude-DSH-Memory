import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { cleanup, tempDir } from './helpers.js'

const TOOL_NAMES = [
  'claude_memory_status',
  'claude_memory_index',
  'claude_memory_manifest',
  'claude_memory_search',
  'claude_memory_read',
  'claude_memory_write',
  'claude_memory_forget',
  'claude_memory_repair_index',
]

/**
 * A ctx stand-in that behaves like Cordis where it matters: reading a service
 * that was not declared in `inject` throws. Any other unknown property access
 * throws too, so the wiring cannot quietly depend on something the real Host
 * would refuse to hand out.
 *
 * @param {{ services?: Record<string, unknown> }} [options]
 */
function makeCtx(options = {}) {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {Array<(exec: any) => string | undefined>} */
  const guards = []
  /** @type {Map<string, Array<(...args: any[]) => any>>} */
  const listeners = new Map()
  /** @type {Array<() => void>} */
  const effects = []
  const services = options.services ?? {}
  const hidden = new Set(['sessions', 'workingDirectory', 'agents', 'llm', 'agentDefaultModel', 'logger'])
  /** @type {string[]} */
  const rejections = []

  const target = {
    tools: {
      /** @param {any} definition */
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      /** @param {(exec: any) => string | undefined} fn */
      guard(fn) {
        guards.push(fn)
        return () => guards.splice(guards.indexOf(fn), 1)
      },
    },
    /** @param {string} name @param {(...args: any[]) => any} fn */
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    /** @param {() => (() => void) | void} fn */
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return () => {}
    },
    /** @param {string} name */
    get(name) {
      return services[name]
    },
    logger: { info() {}, error() {}, debug() {} },
    inject: ['tools'],
  }

  const ctx = new Proxy(target, {
    get(object, property) {
      if (property in object) return /** @type {any} */ (object)[property]
      if (hidden.has(String(property))) {
        throw new Error(`cannot get property "${String(property)}" without inject`)
      }
      throw new Error(`unexpected ctx property "${String(property)}"`)
    },
  })

  return {
    ctx,
    tools,
    guards,
    listeners,
    rejections,
    /** @param {string} name @param {unknown} payload */
    async emit(name, ...args) {
      const list = listeners.get(name) ?? []
      for (const fn of list) await fn(...args)
    },
    /** @param {string} name */
    has(name) {
      return listeners.has(name)
    },
  }
}

/**
 * @param {{ cwd: string, memoryDir: string, stateRoot: string, config?: Record<string, unknown> }} input
 */
function harness(input) {
  const services = {
    sessions: {
      /** @param {string} id */
      get(id) {
        return {
          id,
          header: { origin: 'user' },
          deriveMessages: () => [],
        }
      },
    },
    workingDirectory: {
      /** @param {any} session */
      get(session) {
        return session?.id ? input.cwd : undefined
      },
      defaultDirectory: input.cwd,
    },
    agents: { currentInitiator: () => ({ id: 'agent-1' }) },
    agentDefaultModel: { currentSelection: () => null },
    llm: null,
  }
  const fake = makeCtx({ services })
  apply(fake.ctx, {
    stateRoot: input.stateRoot,
    claudeConfigDir: path.join(input.stateRoot, 'claude'),
    projectMemoryDirs: { [input.cwd]: input.memoryDir },
    ...(input.config ?? {}),
  })
  return fake
}

test('apply wires every tool, the guard and the listeners', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })

    assert.deepEqual([...fake.tools.keys()].sort(), [...TOOL_NAMES].sort())
    assert.equal(fake.guards.length, 1)
    for (const name of ['agent/created', 'agent/pre-step', 'tools/result', 'session/event', 'agent/disposed']) {
      assert.ok(fake.has(name), `listener ${name}`)
    }
  } finally {
    await cleanup(base)
  }
})

test('guard denies writes into the memory directory and allows reads', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })
    const guard = fake.guards[0]

    const target = path.join(memoryDir, 'note.md')
    assert.match(guard({ name: 'write', arguments: { file_path: target } }) ?? '', /claude_memory_write/)
    assert.match(guard({ name: 'edit', arguments: { path: target } }) ?? '', /claude_memory_write/)
    // Relative paths resolve against the caller's working directory.
    assert.match(guard({ name: 'write', arguments: { file_path: '../memory/note.md' }, agent: { id: 'agent-1' } }) ?? '', /claude_memory_write/)

    assert.equal(guard({ name: 'read', arguments: { file_path: target } }), undefined)
    assert.equal(guard({ name: 'grep', arguments: { path: memoryDir } }), undefined)
    assert.equal(guard({ name: 'write', arguments: { file_path: path.join(base, 'other', 'note.md') } }), undefined)
    assert.equal(guard({ name: 'todo_write', arguments: { todos: [] } }), undefined)
  } finally {
    await cleanup(base)
  }
})

test('a guard exception fails open instead of locking every tool out', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })
    // An exec whose `arguments` getter throws is the worst case for a guard.
    const hostile = {
      name: 'write',
      get arguments() {
        throw new Error('boom')
      },
    }
    assert.equal(fake.guards[0](hostile), undefined)
  } finally {
    await cleanup(base)
  }
})

test('a full turn does not throw and leaves no unhandled rejection', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({
      cwd,
      memoryDir,
      stateRoot: path.join(base, 'state'),
      config: {},
    })

    /** @type {unknown[]} */
    const rejections = []
    const onRejection = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const session = { id: 'session-1', header: { origin: 'user' } }
      await fake.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
      await fake.emit('session/event', session, {
        type: 'user/message',
        data: {
          id: 'm1',
          role: 'user',
          content: [{ type: 'text', text: '请把这条决定记住：构建用 pnpm。'.repeat(3) }],
          source: { kind: 'user' },
        },
      })
      await fake.emit('session/event', session, {
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
      })
      await fake.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      // Let the fire-and-forget extraction path settle.
      await new Promise((resolve) => setTimeout(resolve, 120))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    assert.deepEqual(rejections, [])
  } finally {
    await cleanup(base)
  }
})

test('agent/created injects a baseline once for a main session', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })

    /** @type {any[]} */
    const injected = []
    const agent = {
      id: 'agent-1',
      session: { id: 'agent-1', header: { origin: 'user' }, deriveMessages: () => [] },
      inject(message) {
        injected.push(message)
      },
    }
    await fake.emit('agent/created', { agent, source: 'startup' })
    assert.equal(injected.length, 1)
    assert.equal(injected[0].source.kind, 'claude-memory')
    assert.match(injected[0].content[0].text, /Claude-DSH-Memory/)

    // A resume of a session that already has the message must not duplicate it.
    const resumed = {
      id: 'agent-2',
      session: {
        id: 'agent-2',
        header: { origin: 'user' },
        deriveMessages: () => [{ id: 'x', role: 'user', content: [], source: { kind: 'claude-memory' } }],
      },
      inject(message) {
        injected.push(message)
      },
    }
    await fake.emit('agent/created', { agent: resumed, source: 'resume' })
    assert.equal(injected.length, 1)
  } finally {
    await cleanup(base)
  }
})

test('subagent sessions are skipped', async () => {  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })

    let count = 0
    const agent = {
      id: 'agent-1',
      session: { id: 'agent-1', header: { origin: 'subagent' }, deriveMessages: () => [] },
      inject() {
        count += 1
      },
    }
    await fake.emit('agent/created', { agent, source: 'startup' })
    assert.equal(count, 0)
  } finally {
    await cleanup(base)
  }
})

test('the tool surface round-trips a memory through the real store', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })
    const exec = {
      callId: 'c1',
      name: 'claude_memory_write',
      arguments: {},
      agent: { id: 'agent-1' },
      signal: new AbortController().signal,
    }

    const status = await fake.tools.get('claude_memory_status').execute({}, exec)
    assert.equal(status.memoryDir, memoryDir)
    assert.equal(status.confirmed, true)

    const written = await fake.tools.get('claude_memory_write').execute(
      { action: 'create', name: 'build-uses-pnpm', description: '构建使用 pnpm', type: 'project', body: '正文内容' },
      exec,
    )
    assert.equal(written.action, 'create')
    assert.equal(written.filename, 'build-uses-pnpm.md')

    const index = await fake.tools.get('claude_memory_index').execute({}, exec)
    assert.match(index.text, /build-uses-pnpm\.md/)

    const read = await fake.tools.get('claude_memory_read').execute({ filename: written.filename }, exec)
    assert.match(read.body, /正文内容/)
    assert.equal(read.revision, written.revision)

    const forgotten = await fake.tools.get('claude_memory_forget').execute(
      { filename: written.filename, expected_revision: read.revision, reason: '测试' },
      exec,
    )
    assert.equal(forgotten.indexUpdated, true)

    const after = await fake.tools.get('claude_memory_manifest').execute({}, exec)
    assert.equal(after.entries.length, 0)
  } finally {
    await cleanup(base)
  }
})
test('tool renderers receive (args, value) and render the value', async () => {
  const base = await tempDir()
  try {
    const cwd = path.join(base, 'project')
    const memoryDir = path.join(base, 'memory')
    const fake = harness({ cwd, memoryDir, stateRoot: path.join(base, 'state') })

    // The Host calls render(args, value); a renderer that takes only `value`
    // silently renders the arguments object instead (this bug showed up as an
    // empty `{}` tool result in the live session).
    const status = fake.tools.get('claude_memory_status')
    const blocks = status.output.render({}, { memoryDir: '/x', entries: 3 })
    assert.match(blocks[0].text, /"memoryDir": "\/x"/)

    const index = fake.tools.get('claude_memory_index')
    assert.equal(index.output.render({ maxLines: 5 }, { text: 'hello index' })[0].text, 'hello index')
  } finally {
    await cleanup(base)
  }
})