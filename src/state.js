/**
 * Private state layout and counters.
 *
 * Everything here lives under `<stateRoot>` (default `<DSH_HOME>/claude-memory`),
 * never inside a Claude memory directory.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { sha256Hex } from './util.js'

/**
 * Stable, path-case-insensitive key for one memory directory.
 *
 * @param {string} memoryRoot
 * @returns {string}
 */
export function projectKey(memoryRoot) {
  const normalized = path.resolve(memoryRoot)
  const folded = process.platform === 'linux' ? normalized : normalized.toLowerCase()
  return sha256Hex(folded).slice(0, 24)
}

/**
 * Per-project state directories.
 */
export class ProjectState {
  /**
   * @param {{ stateRoot: string, memoryRoot: string }} input
   */
  constructor(input) {
    this.stateRoot = path.resolve(input.stateRoot)
    this.memoryRoot = path.resolve(input.memoryRoot)
    this.key = projectKey(this.memoryRoot)
    this.dir = path.join(this.stateRoot, 'projects', this.key)
    this.queueDir = path.join(this.dir, 'queue')
    this.processingDir = path.join(this.dir, 'processing')
    this.reviewDir = path.join(this.dir, 'review')
    this.backupDir = path.join(this.dir, 'backup')
    this.trashDir = path.join(this.dir, 'trash')
    this.journalDir = path.join(this.dir, 'journal')
    this.cacheDir = path.join(this.dir, 'cache')
    this.lockDir = path.join(this.stateRoot, 'locks', `${this.key}.lock`)
    this.logFile = path.join(this.stateRoot, 'logs', 'plugin.log')
  }

  /** @returns {Promise<void>} */
  async ensure() {
    for (const dir of [
      this.dir,
      this.queueDir,
      this.processingDir,
      this.reviewDir,
      this.backupDir,
      this.trashDir,
      this.journalDir,
      this.cacheDir,
      path.dirname(this.lockDir),
      path.dirname(this.logFile),
    ]) {
      await fs.mkdir(dir, { recursive: true })
    }
  }

  /**
   * @param {'queue'|'processing'|'review'|'backup'|'trash'|'journal'} kind
   * @param {string} name
   * @returns {string}
   */
  file(kind, name) {
    const dir = /** @type {Record<string, string>} */ ({
      queue: this.queueDir,
      processing: this.processingDir,
      review: this.reviewDir,
      backup: this.backupDir,
      trash: this.trashDir,
      journal: this.journalDir,
    })[kind]
    return path.join(dir, name)
  }

  /**
   * Timestamp fragment safe on every filesystem.
   *
   * @returns {string}
   */
  stamp() {
    return new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', '')
  }
}

/**
 * Process-lifetime counters exposed through `claude_memory_status`.
 */
export class Counters {
  constructor() {
    this.extract = { queued: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 }
    this.guard = { denied: 0 }
    /** @type {{ code: string, message: string, at: string } | null} */
    this.lastError = null
  }

  /** @param {'succeeded'|'failed'|'skipped'} outcome */
  countExtract(outcome) {
    this.extract[outcome] += 1
  }

  /** @param {{ code: string, message: string }} error */
  recordError(error) {
    this.lastError = { code: error.code, message: error.message, at: new Date().toISOString() }
  }

  /** @returns {{ extract: Record<string, number>, guard: { denied: number }, lastError: object | null }} */
  snapshot() {
    return {
      extract: { ...this.extract },
      guard: { ...this.guard },
      lastError: this.lastError === null ? null : { ...this.lastError },
    }
  }
}
