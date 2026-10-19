/**
 * Filesystem, hashing and logging primitives shared by every module.
 *
 * The reference implementation (`util.py`, Apache-2.0 upstream) is ported here
 * with the same atomic-write order: temp file in the target directory, fsync,
 * re-check the expected fingerprint, then rename over the target.
 */

import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CODES, MemoryError } from './errors.js'

/** @returns {string} full lowercase hex sha256 of the given text or bytes. */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @returns {string} ISO-8601 UTC timestamp. */
export function utcNowIso() {
  return new Date().toISOString()
}

/**
 * Path used for case-insensitive prefix comparison. Windows and macOS compare
 * case-insensitively; on Linux the raw path is used.
 *
 * @param {string} value
 * @returns {string}
 */
export function compareKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'linux' ? resolved : resolved.toLowerCase()
}

/**
 * Whether `target` is `root` itself or sits below it.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const rootKey = compareKey(root)
  const targetKey = compareKey(target)
  if (targetKey === rootKey) return true
  const withSep = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep
  return targetKey.startsWith(withSep)
}

/**
 * @typedef {{ exists: boolean, size: number, mtimeMs: number, digest: string }} Fingerprint
 */

/** @type {Fingerprint} */
export const MISSING = Object.freeze({ exists: false, size: 0, mtimeMs: 0, digest: '' })

/**
 * Read a file and describe it: existence, size, mtime and content digest.
 * A missing file yields {@link MISSING} rather than throwing.
 *
 * @param {string} file
 * @returns {Promise<Fingerprint>}
 */
export async function fingerprintOf(file) {
  let data
  let stat
  try {
    data = await fs.readFile(file)
    stat = await fs.stat(file)
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return MISSING
    throw error
  }
  return { exists: true, size: data.byteLength, mtimeMs: stat.mtimeMs, digest: sha256Hex(data) }
}

/**
 * Content-only revision used by the tool contract: sha256 of the file bytes.
 *
 * @param {string} file
 * @returns {Promise<{ revision: string, exists: boolean, bytes: number }>}
 */
export async function revisionOf(file) {
  const fingerprint = await fingerprintOf(file)
  return { revision: fingerprint.digest, exists: fingerprint.exists, bytes: fingerprint.size }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function pathExists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * @param {string} file
 * @returns {Promise<import('node:fs').Stats | undefined>}
 */
export async function statIfExists(file) {
  try {
    return await fs.stat(file)
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Atomic text write. When `expected` is given the target must still match it
 * before the temp file is created and again before the rename, so a concurrent
 * writer (Claude Code itself) is detected instead of overwritten.
 *
 * @param {string} file
 * @param {string} content
 * @param {{ expected?: Fingerprint }} [options]
 * @returns {Promise<Fingerprint>} fingerprint of the written file.
 */
export async function atomicWriteText(file, content, options = {}) {
  const expected = options.expected
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })

  if (expected !== undefined) {
    const current = await fingerprintOf(file)
    if (!sameFingerprint(current, expected)) {
      throw new MemoryError(CODES.REVISION_MISMATCH, '文件已被其他进程修改，请重新读取后再试', {
        path: file,
        currentRevision: current.digest,
      })
    }
  }

  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await fs.open(temp, 'wx')
  try {
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (expected !== undefined) {
      const current = await fingerprintOf(file)
      if (!sameFingerprint(current, expected)) {
        throw new MemoryError(CODES.REVISION_MISMATCH, '写入期间文件被其他进程修改，已放弃本次写入', {
          path: file,
          currentRevision: current.digest,
        })
      }
    }
    await fs.rename(temp, file)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
  return fingerprintOf(file)
}

/**
 * @param {Fingerprint} a
 * @param {Fingerprint} b
 * @returns {boolean}
 */
export function sameFingerprint(a, b) {
  if (a.exists !== b.exists) return false
  if (!a.exists) return true
  return a.digest === b.digest
}

/**
 * @param {string} file
 * @param {unknown} payload
 * @returns {Promise<void>}
 */
export async function writeJson(file, payload) {
  await atomicWriteText(file, `${JSON.stringify(payload, null, 2)}\n`)
}

/**
 * @param {string} file
 * @returns {Promise<unknown>}
 */
export async function readJson(file) {
  const text = await fs.readFile(file, 'utf8')
  return JSON.parse(text.replace(/^\uFEFF/, ''))
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clamp a number into an inclusive integer range.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/**
 * Cut text to `max` characters, appending `…` when something was removed.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Append-and-rotate logger. Never writes memory bodies: callers pass only file
 * names, codes and counts.
 */
export class FileLogger {
  /**
   * @param {{ file: string | null, level: 'silent'|'error'|'info'|'debug', sink?: (line: string) => void, maxBytes?: number }} options
   */
  constructor(options) {
    this.file = options.file
    this.level = options.level
    this.sink = options.sink
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024
    this.writes = Promise.resolve()
  }

  /** @param {unknown[]} args */
  error(...args) {
    this.write('error', args)
  }

  /** @param {unknown[]} args */
  info(...args) {
    if (this.level === 'info' || this.level === 'debug') this.write('info', args)
  }

  /** @param {unknown[]} args */
  debug(...args) {
    if (this.level === 'debug') this.write('debug', args)
  }

  /**
   * @param {'error'|'info'|'debug'} level
   * @param {unknown[]} args
   */
  write(level, args) {
    if (this.level === 'silent' && level !== 'error') return
    const message = args
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ')
    const line = `[${utcNowIso()}] ${level.toUpperCase()} ${message}`
    if (this.sink) {
      try {
        this.sink(line)
      } catch {
        /* a broken console must never break memory operations */
      }
    }
    if (this.file === null) return
    const file = this.file
    const maxBytes = this.maxBytes
    this.writes = this.writes
      .then(async () => {
        const stat = await statIfExists(file)
        if (stat && stat.size > maxBytes) {
          await fs.rm(`${file}.1`, { force: true }).catch(() => {})
          await fs.rename(file, `${file}.1`).catch(() => {})
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.appendFile(file, `${line}\n`, 'utf8')
      })
      .catch(() => {})
  }
}
