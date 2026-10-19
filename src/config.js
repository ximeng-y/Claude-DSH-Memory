/**
 * Configuration normalization and validation.
 *
 * The plugin declares no `Config` export:
 * solving `@deepseek-ai/schemastery` from a profile-installed bundle is not
 * guaranteed, so the row's `config` is validated here by hand. Invalid values
 * never prevent the plugin from mounting — they are reported once through
 * `claude_memory_status.warnings` and the baseline injection, and write/read
 * operations refuse with `CM_CONFIG_INVALID` only when the affected field is
 * actually unusable.
 */

import os from 'node:os'
import path from 'node:path'

import { CODES, MemoryError } from './errors.js'
import { clampInt, isPlainObject } from './util.js'

/** @typedef {'user'|'feedback'|'project'|'reference'} MemoryType */
export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'])

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  claudeConfigDir: null,
  projectMemoryDirs: Object.freeze({}),
  createMissing: true,
  injectBaseline: true,
  indexMaxLines: 200,
  indexMaxChars: 12000,
  injectMaxChars: 16000,
  intentReminder: 'pre-step',
  guardEnabled: true,
  autoExtract: true,
  extract: Object.freeze({
    provider: null,
    model: null,
    timeoutMs: 120000,
    maxOperations: 10,
    maxBodyBytes: 65536,
    minUserChars: 30,
    excludeProjects: Object.freeze([]),
  }),
  stateRoot: null,
  lockTimeoutMs: 5000,
  lockStaleMs: 30000,
  logLevel: 'info',
})

const KNOWN_KEYS = new Set([
  ...Object.keys(DEFAULT_CONFIG),
  'minUserChars',
])

/**
 * Absolute default for the Claude Code configuration directory.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function defaultClaudeConfigDir(env) {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.claude')
}

/**
 * Absolute default for the plugin's private state directory.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function defaultStateRoot(env) {
  const home = env.DSH_HOME?.trim()
  const base = home ? path.resolve(home) : path.join(os.homedir(), '.dsh')
  return path.join(base, 'claude-memory')
}

/**
 * Read and validate the row config.
 *
 * @param {unknown} raw the `config` object from cordis.patch.yml.
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {{
 *   config: {
 *     enabled: boolean,
 *     claudeConfigDir: string,
 *     projectMemoryDirs: Array<[string, string]>,
 *     createMissing: boolean,
 *     injectBaseline: boolean,
 *     indexMaxLines: number,
 *     indexMaxChars: number,
 *     injectMaxChars: number,
 *     intentReminder: 'pre-step'|'claimed'|'off',
 *     guardEnabled: boolean,
 *     autoExtract: boolean,
 *     extract: { provider: string|null, model: string|null, timeoutMs: number, maxOperations: number, maxBodyBytes: number, minUserChars: number, excludeProjects: string[] },
 *     stateRoot: string,
 *     lockTimeoutMs: number,
 *     lockStaleMs: number,
 *     logLevel: 'silent'|'error'|'info'|'debug',
 *   },
 *   warnings: string[],
 *   problems: string[],
 * }}
 */
export function resolveConfig(raw, options = {}) {
  const env = options.env ?? process.env
  /** @type {string[]} */
  const warnings = []
  /** @type {string[]} */
  const problems = []
  const input = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) problems.push('插件 config 必须是对象')

  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知配置字段已忽略：${key}`)
  }

  /**
   * @param {string} key
   * @param {boolean} fallback
   */
  const readBool = (key, fallback) => {
    const value = input[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'boolean') {
      problems.push(`${key} 必须是布尔值`)
      return fallback
    }
    return value
  }

  /**
   * @param {string} key
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   * @param {Record<string, unknown>} source
   */
  const readInt = (key, fallback, min, max, source = input) => {
    const value = source[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${key} 必须是整数`)
      return fallback
    }
    if (value < min || value > max) {
      problems.push(`${key} 必须在 ${min}..${max} 之间`)
      return clampInt(value, fallback, min, max)
    }
    return Math.trunc(value)
  }

  /**
   * @param {string} key
   * @param {string|null} fallback
   * @param {Record<string, unknown>} [source]
   */
  const readNullableString = (key, fallback, source = input) => {
    const value = source[key]
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value !== 'string') {
      problems.push(`${key} 必须是字符串`)
      return fallback
    }
    return value.trim()
  }

  /**
   * @param {string} key
   * @param {string} fallback
   * @param {readonly string[]} allowed
   */
  const readEnum = (key, fallback, allowed) => {
    const value = input[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'string' || !allowed.includes(value)) {
      problems.push(`${key} 必须是 ${allowed.join('、')} 之一`)
      return fallback
    }
    return value
  }

  const claudeConfigDirRaw = input.claudeConfigDir
  let claudeConfigDir
  if (claudeConfigDirRaw === undefined || claudeConfigDirRaw === null || claudeConfigDirRaw === '') {
    claudeConfigDir = defaultClaudeConfigDir(env)
  } else if (typeof claudeConfigDirRaw !== 'string') {
    problems.push('claudeConfigDir 必须是绝对路径字符串')
    claudeConfigDir = defaultClaudeConfigDir(env)
  } else if (!path.isAbsolute(claudeConfigDirRaw)) {
    problems.push('claudeConfigDir 必须是绝对路径')
    claudeConfigDir = defaultClaudeConfigDir(env)
  } else {
    claudeConfigDir = path.resolve(claudeConfigDirRaw)
  }

  /** @type {Array<[string, string]>} */
  const projectMemoryDirs = []
  const mapping = input.projectMemoryDirs
  if (mapping !== undefined && mapping !== null) {
    if (!isPlainObject(mapping)) {
      problems.push('projectMemoryDirs 必须是 "项目绝对路径": "记忆目录绝对路径" 的映射')
    } else {
      for (const [key, value] of Object.entries(mapping)) {
        if (typeof value !== 'string' || !path.isAbsolute(key) || !path.isAbsolute(value)) {
          problems.push(`projectMemoryDirs 的键值都必须是绝对路径：${key}`)
          continue
        }
        projectMemoryDirs.push([path.resolve(key), path.resolve(value)])
      }
      // Longest prefix first: the most specific mapping wins.
      projectMemoryDirs.sort((a, b) => b[0].length - a[0].length)
    }
  }

  const stateRootRaw = input.stateRoot
  let stateRoot
  if (stateRootRaw === undefined || stateRootRaw === null || stateRootRaw === '') {
    stateRoot = defaultStateRoot(env)
  } else if (typeof stateRootRaw !== 'string' || !path.isAbsolute(stateRootRaw)) {
    problems.push('stateRoot 必须是绝对路径')
    stateRoot = defaultStateRoot(env)
  } else {
    stateRoot = path.resolve(stateRootRaw)
  }

  const extractRaw = isPlainObject(input.extract) ? input.extract : {}
  if (input.extract !== undefined && input.extract !== null && !isPlainObject(input.extract)) {
    problems.push('extract 必须是对象')
  }
  /** @type {string[]} */
  const excludeProjects = []
  const excludeRaw = extractRaw.excludeProjects ?? DEFAULT_CONFIG.extract.excludeProjects
  if (Array.isArray(excludeRaw)) {
    for (const entry of excludeRaw) {
      if (typeof entry === 'string' && entry.trim()) excludeProjects.push(entry.trim())
    }
  } else if (excludeRaw !== undefined) {
    problems.push('extract.excludeProjects 必须是字符串数组')
  }

  const config = {
    enabled: readBool('enabled', DEFAULT_CONFIG.enabled),
    claudeConfigDir,
    projectMemoryDirs,
    createMissing: readBool('createMissing', DEFAULT_CONFIG.createMissing),
    injectBaseline: readBool('injectBaseline', DEFAULT_CONFIG.injectBaseline),
    indexMaxLines: readInt('indexMaxLines', DEFAULT_CONFIG.indexMaxLines, 1, 100000),
    indexMaxChars: readInt('indexMaxChars', DEFAULT_CONFIG.indexMaxChars, 1, 1000000),
    injectMaxChars: readInt('injectMaxChars', DEFAULT_CONFIG.injectMaxChars, 1, 1000000),
    intentReminder: readEnum('intentReminder', DEFAULT_CONFIG.intentReminder, ['pre-step', 'claimed', 'off']),
    guardEnabled: readBool('guardEnabled', DEFAULT_CONFIG.guardEnabled),
    autoExtract: readBool('autoExtract', DEFAULT_CONFIG.autoExtract),
    extract: {
      provider: readNullableString('provider', null, extractRaw),
      model: readNullableString('model', null, extractRaw),
      timeoutMs: readInt('timeoutMs', DEFAULT_CONFIG.extract.timeoutMs, 1000, 3600000, extractRaw),
      maxOperations: readInt('maxOperations', DEFAULT_CONFIG.extract.maxOperations, 1, 10, extractRaw),
      maxBodyBytes: readInt('maxBodyBytes', DEFAULT_CONFIG.extract.maxBodyBytes, 1024, 1048576, extractRaw),
      minUserChars: readInt('minUserChars', DEFAULT_CONFIG.extract.minUserChars, 0, 100000, extractRaw),
      excludeProjects,
    },
    stateRoot,
    lockTimeoutMs: readInt('lockTimeoutMs', DEFAULT_CONFIG.lockTimeoutMs, 100, 600000),
    lockStaleMs: readInt('lockStaleMs', DEFAULT_CONFIG.lockStaleMs, 1000, 86400000),
    logLevel: readEnum('logLevel', DEFAULT_CONFIG.logLevel, ['silent', 'error', 'info', 'debug']),
  }

  return { config, warnings, problems }
}

/**
 * Refuse to operate when the row config could not be understood.
 *
 * @param {{ problems: readonly string[] }} resolved
 */
export function assertConfigUsable(resolved) {
  if (resolved.problems.length === 0) return
  throw new MemoryError(CODES.CONFIG_INVALID, `插件配置有问题：${resolved.problems[0]}`, {
    problems: resolved.problems.slice(0, 8),
  })
}

/**
 * Whether a memory directory may be used for a project, per `extract.excludeProjects`.
 *
 * @param {string} cwd
 * @param {readonly string[]} excludeProjects
 * @returns {boolean}
 */
export function isExcludedProject(cwd, excludeProjects) {
  if (excludeProjects.length === 0) return false
  const normalized = cwd.replace(/\\/g, '/').toLowerCase()
  return excludeProjects.some((prefix) => {
    const candidate = prefix.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    return normalized === candidate || normalized.startsWith(`${candidate}/`)
  })
}
