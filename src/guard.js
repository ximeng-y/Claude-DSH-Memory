/**
 * The DSH-only write guard.
 *
 * A `ctx.tools.guard()` is synchronous and monotonic: any guard may deny and no
 * listener can force-allow. That makes it the right seam for "do not edit the
 * memory directory with file tools".
 *
 * Two layers, deliberately unequal:
 *  - layer 1 (hard): any tool argument that names a path inside the memory
 *    directory is denied. This covers `write`/`edit` and any future tool that
 *    takes a `path`-shaped argument;
 *  - layer 2 (advisory): a shell command whose text mentions the directory is
 *    denied too. Concatenation, base64, subprocesses and alternate tools all
 *    bypass it — documented as best-effort, never a security boundary.
 */

import path from 'node:path'

import { compareKey } from './util.js'

const PATH_KEYS = new Set(['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath', 'target_file', 'targetFile', 'absolute_path'])
const COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'text'])
const SHELL_TOOL_PATTERN = /^(pwsh|powershell|bash|sh|shell|zsh|cmd|exec|run_command|terminal_send|terminal_open)$/i

/**
 * Tools that may legitimately point at a protected path because they only read.
 * Every other tool is checked, and an unrecognized tool fails closed.
 */
const READ_ONLY_TOOL_PATTERN = /^(read|read_image|grep|glob|search|find|list|stat|head|tail|cat)$/i

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isReadOnlyTool(name) {
  return READ_ONLY_TOOL_PATTERN.test(name)
}

/**
 * Collect every string that looks like a target path in a tool's arguments.
 *
 * @param {unknown} args
 * @returns {string[]}
 */
export function collectPaths(args) {
  /** @type {string[]} */
  const found = []
  /** @param {unknown} value @param {number} depth */
  const walk = (value, depth) => {
    if (depth > 4 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        if (PATH_KEYS.has(key) && entry.trim()) found.push(entry)
      } else if (entry !== null && typeof entry === 'object') {
        walk(entry, depth + 1)
      }
    }
  }
  walk(args, 0)
  return found
}

/**
 * Collect the text of a shell-like invocation.
 *
 * @param {string} name
 * @param {unknown} args
 * @returns {string[]}
 */
export function collectCommands(name, args) {
  if (!SHELL_TOOL_PATTERN.test(name)) return []
  if (args === null || typeof args !== 'object') return []
  /** @type {string[]} */
  const found = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue
    if (!COMMAND_KEYS.has(key)) continue
    if (value.trim()) found.push(value)
  }
  return found
}

/**
 * Normalize a path or command fragment for substring comparison.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeForMatch(value) {
  return String(value)
    .replace(/[\\/]+/g, '/')
    .replace(/["'`]/g, '')
    .toLowerCase()
}

/**
 * Whether a command text mentions one of the protected paths.
 *
 * @param {string} command
 * @param {string[]} protectedPaths
 * @returns {string | null} the matched path, when any.
 */
export function commandMentions(command, protectedPaths) {
  const normalized = normalizeForMatch(command)
  for (const candidate of protectedPaths) {
    const needle = normalizeForMatch(candidate)
    if (needle.length < 6) continue
    if (normalized.includes(needle)) return candidate
  }
  return null
}

/**
 * @typedef {object} WriteGuardOptions
 * @property {() => boolean} enabled
 * @property {(agent: unknown) => string | null} cwdFor resolve the session working directory.
 * @property {(absolutePath: string, cwd: string | null) => boolean} isProtectedPath
 * @property {(cwd: string | null) => string[]} protectedPaths paths whose mention in a command is advisory-denied.
 * @property {(details: { toolName: string, target: string | null }) => void} [onDeny]
 * @property {() => string} message
 */

/**
 * Build the guard function passed to `ctx.tools.guard()`.
 *
 * @param {WriteGuardOptions} options
 * @returns {(exec: { name?: string, arguments?: unknown, agent?: unknown }) => string | undefined}
 */
export function buildWriteGuard(options) {
  return (exec) => {
    if (!options.enabled()) return undefined
    const name = typeof exec?.name === 'string' ? exec.name : ''
    if (!name) return undefined
    if (isReadOnlyTool(name)) return undefined
    const args = exec?.arguments
    const cwd = options.cwdFor(exec?.agent)

    for (const candidate of collectPaths(args)) {
      const absolute = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(cwd ?? process.cwd(), candidate)
      if (options.isProtectedPath(absolute, cwd)) {
        options.onDeny?.({ toolName: name, target: absolute })
        return options.message()
      }
    }

    const protectedPaths = options.protectedPaths(cwd)
    if (protectedPaths.length > 0) {
      for (const command of collectCommands(name, args)) {
        const hit = commandMentions(command, protectedPaths)
        if (hit !== null) {
          options.onDeny?.({ toolName: name, target: hit })
          return options.message()
        }
      }
    }
    return undefined
  }
}

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
export function isPathInsideRoot(root, candidate) {
  const rootKey = compareKey(root)
  const candidateKey = compareKey(candidate)
  if (candidateKey === rootKey) return true
  return candidateKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep)
}

/**
 * The denial text shown to the model.
 *
 * @returns {string}
 */
export function denyMessage() {
  return [
    '这条路径属于 Claude Code 项目记忆目录，DSH 会话内不允许直接用文件工具修改。请改用：',
    '- claude_memory_write（create/update/upsert；更新需 expected_revision）',
    '- claude_memory_forget（需 expected_revision）',
    '- claude_memory_repair_index（索引修复，默认 dryRun）',
    '读取不受限制：claude_memory_read / claude_memory_search / read / grep 都可以。',
  ].join('\n')
}
