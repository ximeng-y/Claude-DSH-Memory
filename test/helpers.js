import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ProjectState } from '../src/state.js'
import { MemoryStore } from '../src/store.js'

const ROOT = path.join(process.cwd(), '.XMTEMP')

/**
 * @param {string} label
 * @returns {Promise<string>}
 */
export async function tempDir(label) {
  const dir = path.join(ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/**
 * @param {{ memoryRoot?: string, stateRoot?: string, config?: Record<string, unknown> }} [options]
 */
export async function makeStore(options = {}) {
  const base = await tempDir('store')
  const memoryRoot = options.memoryRoot ?? path.join(base, 'memory')
  const stateRoot = options.stateRoot ?? path.join(base, 'state')
  await fs.mkdir(memoryRoot, { recursive: true })
  const state = new ProjectState({ stateRoot, memoryRoot })
  const config = {
    indexMaxLines: 200,
    indexMaxChars: 12000,
    lockTimeoutMs: 2000,
    lockStaleMs: 30000,
    createMissing: true,
    ...options.config,
  }
  const store = new MemoryStore({
    memoryRoot,
    state,
    config,
    logger: { info() {}, error() {}, debug() {} },
  })
  return { store, state, memoryRoot, stateRoot, base }
}

/**
 * Remove a temporary tree. Retries because a FileLogger write may still be
 * appending to the log file when the test finishes (ENOTEMPTY on Windows).
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

export const tmpRoot = ROOT
export { os }
