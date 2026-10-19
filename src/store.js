/**
 * The project memory store: read, verify, then write with an atomic rename.
 *
 * All mutations follow the same order as the reference implementation
 * (`store.py`, Apache-2.0 upstream):
 *
 *   1. project lock           5. backup the previous body
 *   2. path containment       6. re-check the index fingerprint
 *   3. compose the new text   7. atomic body write
 *   4. journal entry          8. atomic index write, then drop the journal
 *
 * The index and the body are two files, so a crash between steps 7 and 8 leaves
 * a journal entry and `indexUpdated: false`; `claude_memory_repair_index` is the
 * documented recovery path. Nothing here ever deletes: `forget` moves the file
 * into the plugin's private trash.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CODES, MemoryError } from './errors.js'
import { parseDocument, renderDocument, assertWritable } from './frontmatter.js'
import {
  formatIndexForContext,
  indexTargets,
  parsePointer,
  pointerLine,
  removeIndexText,
  slugifyFilename,
  updateIndexText,
  validateFilename,
} from './indexing.js'
import { atomicWriteText, fingerprintOf, isInside, revisionOf, sleep, statIfExists, writeJson } from './util.js'

export const INDEX_FILE = 'MEMORY.md'

/** @type {Map<string, Promise<unknown>>} */
const inProcessQueues = new Map()

/**
 * Serialize every mutation for one memory directory inside this Host process.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function serialize(key, operation) {
  const previous = inProcessQueues.get(key) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  inProcessQueues.set(
    key,
    next.catch(() => {}),
  )
  return next
}

/**
 * @typedef {object} MemoryEntry
 * @property {string} filename
 * @property {string} name
 * @property {string} description
 * @property {string | null} type
 * @property {number} bytes
 * @property {number} mtimeMs
 * @property {boolean} indexed
 */

export class MemoryStore {
  /**
   * @param {{
   *   memoryRoot: string,
   *   state: import('./state.js').ProjectState,
   *   config: { indexMaxLines: number, indexMaxChars: number, lockTimeoutMs: number, lockStaleMs: number, createMissing: boolean },
   *   logger?: { info: (...args: unknown[]) => void, error: (...args: unknown[]) => void, debug: (...args: unknown[]) => void },
   * }} input
   */
  constructor(input) {
    this.root = path.resolve(input.memoryRoot)
    this.state = input.state
    this.config = input.config
    this.logger = input.logger ?? { info() {}, error() {}, debug() {} }
    this.indexPath = path.join(this.root, INDEX_FILE)
  }

  /** @returns {string} */
  get indexPathLabel() {
    return this.indexPath
  }

  /**
   * Create the memory directory when configured to. Only write paths call this.
   *
   * @returns {Promise<{ created: boolean }>}
   */
  async ensureRoot() {
    const info = await statIfExists(this.root)
    if (info === undefined) {
      if (!this.config.createMissing) {
        throw new MemoryError(CODES.DIR_NOT_FOUND, '记忆目录不存在，且配置禁止创建', { dir: this.root })
      }
      await fs.mkdir(this.root, { recursive: true })
      await atomicWriteText(this.indexPath, '')
      await this.state.ensure()
      this.logger.info(`created memory directory ${this.root}`)
      return { created: true }
    }
    if (!info.isDirectory()) {
      throw new MemoryError(CODES.DIR_UNCONFIRMED, '记忆目录位置存在同名文件', { dir: this.root })
    }
    const indexInfo = await statIfExists(this.indexPath)
    if (indexInfo === undefined) {
      await atomicWriteText(this.indexPath, '')
    }
    await this.state.ensure()
    return { created: false }
  }

  /**
   * @returns {Promise<string>}
   */
  async readIndexText() {
    const info = await fs.lstat(this.indexPath).catch(() => undefined)
    if (info === undefined) return ''
    if (info.isSymbolicLink()) {
      throw new MemoryError(CODES.DIR_UNCONFIRMED, 'MEMORY.md 不允许使用符号链接', { path: this.indexPath })
    }
    return fs.readFile(this.indexPath, 'utf8').then((text) => text.replace(/^\uFEFF/, ''))
  }

  /**
   * @returns {Promise<{ text: string, truncated: boolean, totalLines: number, totalChars: number }>}
   */
  async formattedIndex() {
    const text = await this.readIndexText()
    return formatIndexForContext(text, {
      maxLines: this.config.indexMaxLines,
      maxChars: this.config.indexMaxChars,
    })
  }

  /**
   * @param {{ limit?: number }} [options]
   * @returns {Promise<{ entries: MemoryEntry[], total: number, truncated: boolean }>}
   */
  async manifest(options = {}) {
    const limit = Math.max(0, options.limit ?? 200)
    const indexText = await this.readIndexText().catch(() => '')
    const indexed = indexTargets(indexText)
    const dirents = await fs.readdir(this.root, { withFileTypes: true }).catch((error) => {
      if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return []
      throw error
    })

    /** @type {MemoryEntry[]} */
    const entries = []
    for (const dirent of dirents) {
      const name = dirent.name
      if (name.startsWith('.')) continue
      if (!name.toLowerCase().endsWith('.md')) continue
      if (name.toLowerCase() === INDEX_FILE.toLowerCase()) continue
      if (!dirent.isFile()) continue
      const file = path.join(this.root, name)
      const stat = await fs.stat(file).catch(() => undefined)
      if (stat === undefined) continue
      const text = await fs.readFile(file, 'utf8').catch(() => '')
      const doc = parseDocument(text, name)
      const description = (doc.description ?? doc.body.split('\n')[0] ?? '').trim()
      entries.push({
        filename: name,
        name: doc.name ?? name.replace(/\.md$/i, ''),
        description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
        type: doc.type,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        indexed: indexed.has(name),
      })
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename))
    return { entries: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit }
  }

  /**
   * @param {{ filename?: string | null, name?: string | null }} query
   * @returns {Promise<MemoryEntry>}
   */
  async findEntry(query) {
    const { entries } = await this.manifest({ limit: 10000 })
    return pickEntry(entries, query)
  }

  /**
   * @param {{ filename?: string | null, name?: string | null }} query
   * @returns {Promise<{ filename: string, name: string, description: string, type: string|null, body: string, revision: string, bytes: number, mtimeMs: number }>}
   */
  async read(query) {
    const entry = await this.findEntry(query)
    const file = path.join(this.root, entry.filename)
    const { revision, bytes } = await revisionOf(file)
    const text = await fs.readFile(file, 'utf8')
    const doc = parseDocument(text, entry.filename)
    return {
      filename: entry.filename,
      name: doc.name ?? entry.name,
      description: doc.description ?? entry.description,
      type: doc.type,
      body: doc.body,
      revision,
      bytes,
      mtimeMs: entry.mtimeMs,
    }
  }

  /**
   * Create, update or upsert one memory file and keep `MEMORY.md` in sync.
   *
   * @param {{
   *   action: 'create'|'update'|'upsert',
   *   filename?: string | null,
   *   name?: string | null,
   *   description?: string | null,
   *   type?: string | null,
   *   body?: string | null,
   *   title?: string | null,
   *   originSessionId?: string | null,
   *   expectedRevision?: string | null,
   * }} input
   * @returns {Promise<{ action: string, filename: string, revision: string, indexUpdated: boolean, bytes: number, warning?: string }>}
   */
  async write(input) {
    const action = String(input.action ?? 'upsert').trim().toLowerCase()
    if (!['create', 'update', 'upsert'].includes(action)) {
      throw new MemoryError(CODES.CONFIG_INVALID, 'action 必须是 create、update 或 upsert')
    }
    const body = String(input.body ?? '').trim()
    if (!body) throw new MemoryError(CODES.BODY_EMPTY, 'body 不能为空')

    await this.ensureRoot()
    return serialize(this.state.key, () =>
      this.locked(async () => {
        const existing = await this.resolveExisting({ filename: input.filename, name: input.name })
        if (existing !== null && action === 'create') {
          throw new MemoryError(CODES.FILE_EXISTS, `记忆已存在：${existing.filename}；请改用 update 或 upsert`, {
            filename: existing.filename,
            revision: (await revisionOf(path.join(this.root, existing.filename))).revision,
          })
        }
        if (existing === null && action === 'update') {
          throw new MemoryError(CODES.FILE_NOT_FOUND, 'update 目标不存在；请先 search 或 manifest 确认目标', {
            filename: input.filename ?? null,
            name: input.name ?? null,
          })
        }
        if (existing !== null && !input.expectedRevision) {
          throw new MemoryError(CODES.REVISION_REQUIRED, '更新已有记忆必须带 expected_revision（先 read 取得）', {
            filename: existing.filename,
          })
        }

        const targetFilename = existing?.filename ?? this.filenameForNew(input)
        const target = this.containedPath(targetFilename)
        const previous = await fingerprintOf(target)
        if (existing !== null && input.expectedRevision !== undefined && input.expectedRevision !== null && previous.digest !== input.expectedRevision) {
          const preview = await fs.readFile(target, 'utf8').then((text) => text.slice(0, 200)).catch(() => '')
          throw new MemoryError(CODES.REVISION_MISMATCH, '记忆已被修改，请重新 read 后再更新', {
            filename: targetFilename,
            currentRevision: previous.digest,
            currentPreview: preview,
          })
        }

        const oldText = existing === null ? '' : await fs.readFile(target, 'utf8')
        if (existing !== null) assertWritable(oldText, targetFilename)
        const oldDoc = existing === null ? null : parseDocument(oldText, targetFilename)
        const finalName = (input.name ?? oldDoc?.name ?? '').trim()
        const finalType = (input.type ?? oldDoc?.type ?? '').trim()
        if (existing !== null && !finalName) {
          throw new MemoryError(CODES.INTERNAL, '更新已有记忆时无法确定 name，请显式提供 name')
        }
        if (existing !== null && !finalType) {
          throw new MemoryError(CODES.INVALID_TYPE, '更新已有记忆时无法确定 type，请显式提供 type')
        }
        const finalDescription = String(input.description ?? '').trim() || (oldDoc?.description ?? '')
        const rendered = renderDocument({
          existingText: oldText,
          filename: targetFilename,
          name: finalName,
          description: finalDescription,
          type: finalType,
          body,
        })

        const indexExpected = await fingerprintOf(this.indexPath)
        const journal = await this.createJournal({
          action,
          filename: targetFilename,
          title: input.title ?? finalName,
          description: finalDescription,
        })
        if (existing !== null) await this.backup(target)

        const indexNow = await fingerprintOf(this.indexPath)
        if (indexNow.digest !== indexExpected.digest) {
          throw new MemoryError(CODES.REVISION_MISMATCH, 'MEMORY.md 在写入期间被其他进程修改，已放弃本次写入', {
            filename: targetFilename,
          })
        }

        const written = await atomicWriteText(target, rendered, { expected: previous })
        let indexUpdated = true
        /** @type {string | undefined} */
        let warning
        try {
          await this.updateIndex(targetFilename, input.title ?? finalName, finalDescription)
        } catch (error) {
          indexUpdated = false
          warning = `正文已写入，但索引更新失败：${error instanceof Error ? error.message : String(error)}；请调用 claude_memory_repair_index`
          this.logger.error('index update failed', targetFilename, error)
        }
        if (indexUpdated) await this.completeJournal(journal)
        else await this.updateJournal(journal, { indexFailed: true })

        return {
          action: existing === null ? 'create' : action === 'upsert' ? 'update' : action,
          filename: targetFilename,
          revision: written.digest,
          indexUpdated,
          bytes: written.size,
          ...(warning === undefined ? {} : { warning }),
        }
      }),
    )
  }

  /**
   * Move one memory file into the private trash and drop its pointer.
   *
   * @param {{ filename?: string | null, name?: string | null, expectedRevision?: string | null, reason?: string | null }} input
   * @returns {Promise<{ filename: string, trashedTo: string, indexUpdated: boolean, warning?: string }>}
   */
  async forget(input) {
    await this.ensureRoot()
    return serialize(this.state.key, () =>
      this.locked(async () => {
        const entry = await this.findEntry({ filename: input.filename, name: input.name })
        const target = path.join(this.root, entry.filename)
        const current = await fingerprintOf(target)
        if (!input.expectedRevision) {
          throw new MemoryError(CODES.REVISION_REQUIRED, '删除记忆必须带 expected_revision（先 read 取得）', { filename: entry.filename })
        }
        if (input.expectedRevision !== current.digest) {
          const preview = await fs.readFile(target, 'utf8').then((text) => text.slice(0, 200)).catch(() => '')
          throw new MemoryError(CODES.REVISION_MISMATCH, '记忆已被修改，请重新 read 后再删除', {
            filename: entry.filename,
            currentRevision: current.digest,
            currentPreview: preview,
          })
        }

        await this.state.ensure()
        const journal = await this.createJournal({
          action: 'forget',
          filename: entry.filename,
          title: '',
          description: String(input.reason ?? ''),
        })
        await this.backup(target)
        const trashPath = this.state.file('trash', `${this.state.stamp()}-${entry.filename}`)
        await moveFile(target, trashPath, current)

        let indexUpdated = true
        /** @type {string | undefined} */
        let warning
        try {
          await this.removeIndex(entry.filename)
        } catch (error) {
          indexUpdated = false
          warning = `文件已移入 trash，但索引更新失败：${error instanceof Error ? error.message : String(error)}；请调用 claude_memory_repair_index`
          this.logger.error('index removal failed', entry.filename, error)
        }
        if (indexUpdated) await this.completeJournal(journal)
        else await this.updateJournal(journal, { indexFailed: true })
        return {
          filename: entry.filename,
          trashedTo: trashPath,
          indexUpdated,
          ...(warning === undefined ? {} : { warning }),
        }
      }),
    )
  }

  /**
   * Reconcile `MEMORY.md` with the files on disk.
   *
   * @param {{ dryRun?: boolean }} [options]
   * @returns {Promise<{ applied: boolean, changes: Array<{ kind: 'add'|'remove'|'update', filename: string, line?: string, from?: string, to?: string }> }>}
   */
  async repairIndex(options = {}) {
    const dryRun = options.dryRun !== false
    await this.ensureRoot()
    return serialize(this.state.key, () =>
      this.locked(async () => {
        const { entries } = await this.manifest({ limit: 10000 })
        const indexExpected = await fingerprintOf(this.indexPath)
        const current = await this.readIndexText()
        const lines = current.split(/\r\n|\n|\r/)
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const actual = new Map(entries.map((entry) => [entry.filename, entry]))
        const seen = new Set()
        /** @type {Array<{ kind: 'add'|'remove'|'update', filename: string, line?: string, from?: string, to?: string }>} */
        const changes = []
        /** @type {string[]} */
        const nextLines = []

        for (const line of lines) {
          const pointer = parsePointer(line)
          if (pointer === null) {
            nextLines.push(line)
            continue
          }
          const filename = pointer.filename.replace(/\\/g, '/')
          const entry = actual.get(filename)
          if (entry === undefined) {
            changes.push({ kind: 'remove', filename, line })
            continue
          }
          const replacement = pointerLine(entry.name, filename, entry.description)
          if (replacement !== line) changes.push({ kind: 'update', filename, from: line, to: replacement })
          nextLines.push(replacement)
          seen.add(filename)
        }
        for (const filename of [...actual.keys()].sort()) {
          if (seen.has(filename)) continue
          const entry = /** @type {MemoryEntry} */ (actual.get(filename))
          const line = pointerLine(entry.name, filename, entry.description)
          changes.push({ kind: 'add', filename, line })
          nextLines.push(line)
        }

        const next = nextLines.length === 0 ? '' : `${nextLines.join('\n')}\n`
        if (dryRun || changes.length === 0 || next === current) {
          return { applied: false, changes }
        }
        if (current) {
          const backup = this.state.file('backup', `MEMORY-${this.state.stamp()}.md`)
          await atomicWriteText(backup, current)
        }
        await atomicWriteText(this.indexPath, next, { expected: indexExpected })
        return { applied: true, changes }
      }),
    )
  }

  /**
   * Whole-directory fingerprint used by the extraction publish guard.
   *
   * @returns {Promise<Record<string, string>>}
   */
  async dirFingerprint() {
    /** @type {Record<string, string>} */
    const result = {}
    const names = [INDEX_FILE]
    const dirents = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue
      if (dirent.name.startsWith('.')) continue
      if (!dirent.name.toLowerCase().endsWith('.md')) continue
      if (dirent.name.toLowerCase() === INDEX_FILE.toLowerCase()) continue
      names.push(dirent.name)
    }
    for (const name of names.sort()) {
      const fingerprint = await fingerprintOf(path.join(this.root, name))
      result[name] = fingerprint.exists ? fingerprint.digest : ''
    }
    return result
  }

  /**
   * @returns {Promise<{ journal: number, queue: number, processing: number, review: number, trash: number }>}
   */
  async stateCounts() {
    /** @param {string} dir */
    const count = async (dir) => {
      const list = await fs.readdir(dir).catch(() => [])
      return list.length
    }
    return {
      journal: await count(this.state.journalDir),
      queue: await count(this.state.queueDir),
      processing: await count(this.state.processingDir),
      review: await count(this.state.reviewDir),
      trash: await count(this.state.trashDir),
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * @param {{ filename?: string | null, name?: string | null }} query
   * @returns {Promise<MemoryEntry | null>}
   */
  async resolveExisting(query) {
    const hasFilename = Boolean(query.filename && String(query.filename).trim())
    const hasName = Boolean(query.name && String(query.name).trim())
    if (!hasFilename && !hasName) return null
    const { entries } = await this.manifest({ limit: 10000 })
    if (hasFilename) {
      const filename = validateFilename(String(query.filename))
      return entries.find((entry) => entry.filename === filename) ?? null
    }
    const wanted = String(query.name).trim()
    const matches = entries.filter((entry) => entry.name === wanted)
    if (matches.length > 1) {
      throw new MemoryError(CODES.AMBIGUOUS_NAME, `name 对应多条记忆，请改用 filename：${wanted}`, {
        candidates: matches.map((entry) => entry.filename),
      })
    }
    return matches[0] ?? null
  }

  /**
   * @param {{ filename?: string | null, name?: string | null, description?: string | null }} input
   * @returns {string}
   */
  filenameForNew(input) {
    if (input.filename && String(input.filename).trim()) return validateFilename(String(input.filename))
    const seed = String(input.name ?? '').trim() || String(input.description ?? '').trim()
    if (!seed) throw new MemoryError(CODES.INVALID_FILENAME, '必须提供 filename 或 name')
    return slugifyFilename(seed)
  }

  /**
   * @param {string} filename
   * @returns {string} absolute path known to stay inside the memory root.
   */
  containedPath(filename) {
    const clean = validateFilename(filename)
    const target = path.join(this.root, clean)
    if (!isInside(this.root, target)) {
      throw new MemoryError(CODES.INVALID_FILENAME, 'filename 越过记忆目录', { filename })
    }
    return target
  }

  /**
   * @param {string} filename
   * @param {string} title
   * @param {string} description
   * @returns {Promise<void>}
   */
  async updateIndex(filename, title, description) {
    const current = await this.readIndexText()
    const next = updateIndexText(current, { filename, title, description })
    await atomicWriteText(this.indexPath, next)
  }

  /**
   * @param {string} filename
   * @returns {Promise<void>}
   */
  async removeIndex(filename) {
    const current = await this.readIndexText()
    const next = removeIndexText(current, { filename })
    await atomicWriteText(this.indexPath, next)
  }

  /**
   * @param {string} target
   * @returns {Promise<void>}
   */
  async backup(target) {
    const content = await fs.readFile(target)
    const dest = this.state.file('backup', `${this.state.stamp()}-${path.basename(target)}`)
    await atomicWriteText(dest, content.toString('utf8'))
  }

  /**
   * @param {{ action: string, filename: string, title: string, description: string }} input
   * @returns {Promise<string>}
   */
  async createJournal(input) {
    await this.state.ensure()
    const file = this.state.file('journal', `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}.json`)
    await writeJson(file, { ...input, createdAt: new Date().toISOString() })
    return file
  }

  /**
   * @param {string} file
   * @param {Record<string, unknown>} patch
   * @returns {Promise<void>}
   */
  async updateJournal(file, patch) {
    try {
      await writeJson(file, { ...patch, updatedAt: new Date().toISOString() })
    } catch {
      /* diagnostics only */
    }
  }

  /**
   * @param {string} file
   * @returns {Promise<void>}
   */
  async completeJournal(file) {
    await fs.rm(file, { force: true }).catch(() => {})
  }

  /**
   * Cross-process directory lock with stale detection.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async locked(operation) {
    const lockDir = this.state.lockDir
    await fs.mkdir(path.dirname(lockDir), { recursive: true })
    const deadline = Date.now() + this.config.lockTimeoutMs
    for (;;) {
      try {
        await fs.mkdir(lockDir)
        await writeJson(path.join(lockDir, 'owner.json'), {
          pid: process.pid,
          host: path.basename(process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'host'),
          time: new Date().toISOString(),
        }).catch(() => {})
        break
      } catch (error) {
        if (/** @type {{ code?: string }} */ (error)?.code !== 'EEXIST') throw error
        const stat = await statIfExists(lockDir)
        if (stat !== undefined && Date.now() - stat.mtimeMs > this.config.lockStaleMs) {
          await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
        if (Date.now() > deadline) {
          throw new MemoryError(CODES.LOCK_TIMEOUT, '等待记忆目录锁超时，请稍后重试', { lockDir })
        }
        await sleep(100)
      }
    }
    try {
      return await operation()
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/**
 * @param {MemoryEntry[]} entries
 * @param {{ filename?: string | null, name?: string | null }} query
 * @returns {MemoryEntry}
 */
export function pickEntry(entries, query) {
  const hasFilename = Boolean(query.filename && String(query.filename).trim())
  const hasName = Boolean(query.name && String(query.name).trim())
  if (hasFilename) {
    const filename = validateFilename(String(query.filename))
    const found = entries.find((entry) => entry.filename === filename)
    if (found === undefined) throw new MemoryError(CODES.FILE_NOT_FOUND, `记忆不存在：${filename}`, { filename })
    return found
  }
  if (!hasName) throw new MemoryError(CODES.INTERNAL, '必须提供 filename 或 name')
  const wanted = String(query.name).trim()
  const matches = entries.filter((entry) => entry.name === wanted)
  if (matches.length === 0) throw new MemoryError(CODES.FILE_NOT_FOUND, `记忆不存在：${wanted}`, { name: wanted })
  if (matches.length > 1) {
    throw new MemoryError(CODES.AMBIGUOUS_NAME, `name 对应多条记忆，请改用 filename：${wanted}`, {
      candidates: matches.map((entry) => entry.filename),
    })
  }
  return matches[0]
}

/**
 * `rename` across devices needs a copy; both ends stay under plugin control.
 *
 * @param {string} from
 * @param {string} to
 * @param {import('./util.js').Fingerprint} expected
 * @returns {Promise<void>}
 */
async function moveFile(from, to, expected) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    const current = await fingerprintOf(from)
    if (current.digest !== expected.digest) {
      throw new MemoryError(CODES.REVISION_MISMATCH, '移动前检测到外部修改', { from })
    }
    await fs.rename(from, to)
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code
    if (code !== 'EXDEV') throw error
    const content = await fs.readFile(from, 'utf8')
    await atomicWriteText(to, content)
    await fs.rm(from, { force: true })
  }
}
