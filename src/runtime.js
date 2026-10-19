/**
 * Runtime glue between Host sessions and the store.
 *
 * Owns configuration-derived caches (memory root per working directory, store
 * per memory root), the private state directory and the counters that
 * `claude_memory_status` reports. Tools and event listeners never construct a
 * store themselves.
 */

import path from 'node:path'

import { CODES, MemoryError, asMemoryError } from './errors.js'
import { assertStateOutsideMemory, assertUsableRoot, inspectMemoryRoot, resolveMemoryRoot } from './paths.js'
import { Counters, ProjectState } from './state.js'
import { MemoryStore } from './store.js'
import { compareKey, statIfExists } from './util.js'

const RESOLVE_TTL_MS = 15_000

export class MemoryRuntime {
  /**
   * @param {{
   *   config: object,
   *   warnings: string[],
   *   problems: string[],
   *   env: Record<string, string | undefined>,
   *   logger: { info: (...args: unknown[]) => void, error: (...args: unknown[]) => void, debug: (...args: unknown[]) => void },
   * }} input
   */
  constructor(input) {
    this.config = input.config
    this.warnings = [...input.warnings, ...input.problems]
    this.problems = input.problems
    this.env = input.env
    this.logger = input.logger
    this.counters = new Counters()
    /** @type {Map<string, { at: number, value: import('./paths.js').ResolvedMemoryRoot }>} */
    this.resolutions = new Map()
    /** @type {Map<string, MemoryStore>} */
    this.stores = new Map()
  }

  /**
   * @param {string} cwd
   * @returns {Promise<import('./paths.js').ResolvedMemoryRoot>}
   */
  async resolve(cwd) {
    const key = compareKey(cwd)
    const cached = this.resolutions.get(key)
    if (cached !== undefined && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value
    const value = await resolveMemoryRoot({ cwd: path.resolve(cwd), config: this.config, env: this.env })
    this.resolutions.set(key, { at: Date.now(), value })
    return value
  }

  /**
   * Resolve the store for a session working directory. Does not create anything.
   *
   * @param {string} cwd
   * @returns {Promise<{ store: MemoryStore, resolved: import('./paths.js').ResolvedMemoryRoot }>}
   */
  async store(cwd) {
    const resolved = await this.resolve(cwd)
    let store = this.stores.get(resolved.dir)
    if (store === undefined) {
      const state = new ProjectState({ stateRoot: this.config.stateRoot, memoryRoot: resolved.dir })
      store = new MemoryStore({
        memoryRoot: resolved.dir,
        state,
        config: this.config,
        logger: this.logger,
      })
      this.stores.set(resolved.dir, store)
    }
    return { store, resolved }
  }

  /**
   * Root state directory, created lazily.
   *
   * @returns {import('./state.js').ProjectState | null}
   */
  stateFor(dir) {
    return new ProjectState({ stateRoot: this.config.stateRoot, memoryRoot: dir })
  }

  /**
   * Full status payload for `claude_memory_status`.
   *
   * @param {string} cwd
   * @returns {Promise<Record<string, unknown>>}
   */
  async status(cwd) {
    const counters = this.counters.snapshot()
    /** @type {Record<string, unknown>} */
    let payload
    try {
      const { store, resolved } = await this.store(cwd)
      const info = await inspectMemoryRoot(resolved.dir)
      const indexInfo = await statIfExists(path.join(resolved.dir, 'MEMORY.md'))
      const indexText = await store.readIndexText().catch(() => '')
      const { entries, total } = await store.manifest({ limit: 10000 })
      const counts = await store.stateCounts()
      /** @type {Record<string, number>} */
      const types = { user: 0, feedback: 0, project: 0, reference: 0, unknown: 0 }
      for (const entry of entries) {
        if (entry.type !== null && entry.type in types) types[entry.type] += 1
        else types.unknown += 1
      }
      /** @type {string[]} */
      const warnings = [...this.warnings]
      if (!resolved.confirmed) warnings.push('记忆目录由路径规则推断，尚未在 Claude Code 中核对；如不一致请配置 projectMemoryDirs')
      if (counts.journal > 0) warnings.push(`有 ${counts.journal} 条未完成的写入 journal；请用 claude_memory_repair_index 检查索引`)
      if (counts.review > 0) warnings.push(`有 ${counts.review} 条被放弃的提取材料，可在状态目录 review/ 查看`)
      payload = {
        memoryDir: resolved.dir,
        projectRoot: resolved.projectRoot,
        source: resolved.source,
        confirmed: resolved.confirmed,
        exists: info.exists,
        slugVersion: resolved.slugVersion,
        index: {
          exists: indexInfo !== undefined,
          lines: indexText === '' ? 0 : indexText.split(/\r\n|\n|\r/).filter((line) => line !== '').length,
          bytes: indexInfo?.size ?? 0,
        },
        entries: total,
        types,
        extraction: {
          enabled: this.config.autoExtract,
          queued: counts.queue,
          running: counts.processing,
          succeeded: counters.extract.succeeded,
          failed: counters.extract.failed,
          skipped: counters.extract.skipped,
        },
        protection: {
          enabled: this.config.guardEnabled,
          denied: counters.guard.denied,
          note: 'shell 内绕过（拼接、编码、子进程）只做提示性拦截，不是安全边界',
        },
        counters,
        warnings,
      }
    } catch (error) {
      const typed = asMemoryError(error)
      payload = {
        memoryDir: null,
        exists: false,
        error: { code: typed.code, message: typed.message },
        extraction: { enabled: this.config.autoExtract },
        protection: { enabled: this.config.guardEnabled, denied: counters.guard.denied },
        warnings: [...this.warnings, `${typed.code}: ${typed.message}`],
      }
    }
    return payload
  }

  /**
   * @param {string} cwd
   * @returns {Promise<MemoryStore>}
   */
  async writableStore(cwd) {
    if (this.problems.length > 0) {
      throw new MemoryError(CODES.CONFIG_INVALID, `插件配置有问题：${this.problems[0]}`, { problems: this.problems.slice(0, 8) })
    }
    const { store, resolved } = await this.store(cwd)
    assertStateOutsideMemory(this.config.stateRoot, resolved.dir)
    const info = await inspectMemoryRoot(resolved.dir)
    if (info.exists) await assertUsableRoot(resolved.dir)
    await store.ensureRoot()
    return store
  }

  /** @param {string} cwd */
  dropCache(cwd) {
    this.resolutions.delete(compareKey(cwd))
  }
}
