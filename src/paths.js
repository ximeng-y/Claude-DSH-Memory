/**
 * Resolve which Claude Code project memory directory belongs to a workspace.
 *
 * The resolution order is a fixed contract. It never
 * creates anything: creation is a write-time decision made by the store, and a
 * directory produced by the slug guess is marked `confirmed: false` so the
 * plugin can say so in `claude_memory_status` and in the baseline injection.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CODES, MemoryError } from './errors.js'
import { compareKey, isInside } from './util.js'

const SLUG_VERSION = 1
const GIT_CACHE_TTL_MS = 60_000
const GIT_TIMEOUT_MS = 5_000

/** @type {Map<string, { at: number, value: GitLayout }>} */
const gitCache = new Map()

/**
 * @typedef {{ kind: 'ok', root: string } | { kind: 'not-a-repo' } | { kind: 'unavailable' } | { kind: 'unsupported', commonDir: string }} GitLayout
 */

/**
 * Claude Code's project slug for a canonical project root (slug algorithm v1):
 * every character outside `[A-Za-z0-9]` becomes `-`.
 *
 * @param {string} root absolute project path.
 * @returns {string}
 */
export function slugForPath(root) {
  return path.resolve(root).replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Whether a path can be represented by slug algorithm v1 without ambiguity.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function canSlug(root) {
  const resolved = path.resolve(root)
  if (resolved.length > 180) return false
  return /^[\x20-\x7e]+$/.test(resolved)
}

/**
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function existsUpwardDotGit(dir) {
  let cursor = path.resolve(dir)
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const stat = await fs.stat(path.join(cursor, '.git'))
      if (stat.isDirectory() || stat.isFile()) return true
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) return false
    cursor = parent
  }
  return false
}

/**
 * @param {string} cwd
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<GitLayout>}
 */
export async function gitLayout(cwd, options = {}) {
  const key = compareKey(cwd)
  const cached = gitCache.get(key)
  if (cached && Date.now() - cached.at < GIT_CACHE_TTL_MS) return cached.value

  const timeout = options.timeoutMs ?? GIT_TIMEOUT_MS
  /** @type {GitLayout} */
  let value
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { timeout, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, out) => {
          if (error) reject(error)
          else resolve(String(out))
        },
      )
    })
    const commonDir = stdout.trim().split(/\r?\n/)[0] ?? ''
    if (!commonDir) {
      value = { kind: 'not-a-repo' }
    } else if (path.basename(commonDir) === '.git') {
      value = { kind: 'ok', root: path.dirname(commonDir) }
    } else {
      value = { kind: 'unsupported', commonDir }
    }
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code
    if (code === 'ENOENT') {
      value = (await existsUpwardDotGit(cwd)) ? { kind: 'unavailable' } : { kind: 'not-a-repo' }
    } else if (code === 'ETIMEDOUT') {
      value = (await existsUpwardDotGit(cwd)) ? { kind: 'unavailable' } : { kind: 'not-a-repo' }
    } else {
      // `git` present but the directory is not a repository (exit code 128).
      value = (await existsUpwardDotGit(cwd)) ? { kind: 'unavailable' } : { kind: 'not-a-repo' }
    }
  }
  gitCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * @typedef {object} ResolvedMemoryRoot
 * @property {string} dir absolute memory directory (`…/projects/<slug>/memory`).
 * @property {string} projectRoot canonical project root the resolution used.
 * @property {'mapping'|'mapping-git'|'user-settings'|'env-dir-name'|'slug'} source
 * @property {boolean} confirmed true when the path came from an explicit mapping.
 * @property {number} slugVersion
 * @property {string[]} warnings
 */

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isAbsoluteDirectoryName(candidate) {
  return Boolean(candidate) && !candidate.includes('/') && !candidate.includes('\\') && !candidate.includes(':') && candidate !== '.' && candidate !== '..'
}

/**
 * @param {string} root
 * @param {Array<[string, string]>} mapping
 * @returns {string | null}
 */
function lookupMapping(root, mapping) {
  const rootKey = compareKey(root)
  for (const [projectPath, memoryDir] of mapping) {
    const candidate = compareKey(projectPath)
    if (rootKey === candidate || rootKey.startsWith(candidate + path.sep)) return memoryDir
  }
  return null
}

/**
 * @param {string} file
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readJsonSettings(file) {
  try {
    const text = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? /** @type {Record<string, unknown>} */ (parsed) : null
  } catch {
    return null
  }
}

/**
 * Resolve the memory directory for a session working directory.
 *
 * @param {{ cwd: string, config: { claudeConfigDir: string, projectMemoryDirs: Array<[string, string]> }, env?: Record<string, string | undefined> }} input
 * @returns {Promise<ResolvedMemoryRoot>}
 */
export async function resolveMemoryRoot(input) {
  const cwd = path.resolve(input.cwd)
  const config = input.config
  const env = input.env ?? process.env
  /** @type {string[]} */
  const warnings = []

  /** @type {string | null} */
  let memoryDir = lookupMapping(cwd, config.projectMemoryDirs)
  let source = /** @type {ResolvedMemoryRoot['source']} */ ('mapping')
  let projectRoot = cwd

  /** @type {GitLayout} */
  let layout = { kind: 'not-a-repo' }
  if (memoryDir === null) {
    layout = await gitLayout(cwd)
    if (layout.kind === 'unsupported') {
      throw new MemoryError(
        CODES.GIT_LAYOUT_UNSUPPORTED,
        '这个仓库的 .git 布局不是标准布局（common dir 不叫 .git），请用 projectMemoryDirs 显式映射记忆目录',
        { commonDir: layout.commonDir },
      )
    }
    if (layout.kind === 'unavailable') {
      throw new MemoryError(
        CODES.GIT_UNAVAILABLE,
        '这是 Git 仓库但找不到可用的 git 命令，无法把子目录归一到仓库根；请安装 git 或显式映射记忆目录',
        { cwd },
      )
    }
    if (layout.kind === 'ok') {
      projectRoot = layout.root
      memoryDir = lookupMapping(projectRoot, config.projectMemoryDirs)
      if (memoryDir !== null) source = 'mapping-git'
    }
  }

  if (memoryDir === null) {
    const projectSettings = await readProjectSettings(cwd, projectRoot)
    if (projectSettings !== null) {
      throw new MemoryError(
        CODES.DIR_NEEDS_MAPPING,
        `仓库内 .claude/${projectSettings.file} 配置了 autoMemoryDirectory，DSH 无法判断该仓库的信任状态，不会静默采用；请用 projectMemoryDirs 显式映射`,
        { settingsFile: projectSettings.file, autoMemoryDirectory: projectSettings.value },
      )
    }

    const userSettings = await readJsonSettings(path.join(config.claudeConfigDir, 'settings.json'))
    const userAuto = userSettings?.autoMemoryDirectory
    if (typeof userAuto === 'string' && userAuto.trim()) {
      if (!path.isAbsolute(userAuto)) {
        throw new MemoryError(CODES.CONFIG_INVALID, 'Claude 用户设置里的 autoMemoryDirectory 必须是绝对路径', { autoMemoryDirectory: userAuto })
      }
      memoryDir = path.resolve(userAuto)
      source = 'user-settings'
    }
  }

  if (memoryDir === null) {
    const dirName = env.CLAUDE_CODE_PROJECT_DIR_NAME?.trim()
    if (dirName) {
      if (!isAbsoluteDirectoryName(dirName)) {
        throw new MemoryError(CODES.CONFIG_INVALID, 'CLAUDE_CODE_PROJECT_DIR_NAME 必须是单个目录名', { value: dirName })
      }
      memoryDir = path.join(config.claudeConfigDir, 'projects', dirName, 'memory')
      source = 'env-dir-name'
    }
  }

  if (memoryDir === null) {
    if (!canSlug(projectRoot)) {
      throw new MemoryError(
        CODES.DIR_UNDETERMINED,
        '项目路径含非 ASCII 字符或过长，无法按 slug 规则推断 Claude 记忆目录；请用 projectMemoryDirs 显式映射',
        { projectRoot },
      )
    }
    memoryDir = path.join(config.claudeConfigDir, 'projects', slugForPath(projectRoot), 'memory')
    source = 'slug'
  }

  const confirmed = source === 'mapping' || source === 'mapping-git'
  if (source === 'slug') {
    warnings.push('记忆目录由路径规则推断，尚未在 Claude Code 中核对')
  }

  return { dir: memoryDir, projectRoot, source, confirmed, slugVersion: SLUG_VERSION, warnings }
}

/**
 * @param {string} cwd
 * @param {string} projectRoot
 * @returns {Promise<{ file: string, value: string } | null>}
 */
async function readProjectSettings(cwd, projectRoot) {
  const roots = cwd === projectRoot ? [cwd] : [cwd, projectRoot]
  for (const root of roots) {
    for (const file of ['settings.local.json', 'settings.json']) {
      const settings = await readJsonSettings(path.join(root, '.claude', file))
      const value = settings?.autoMemoryDirectory
      if (typeof value === 'string' && value.trim()) return { file, value }
    }
  }
  return null
}

/**
 * Inspect a resolved directory without creating anything.
 *
 * @param {string} dir
 * @returns {Promise<{ exists: boolean, isDirectory: boolean, isLink: boolean }>}
 */
export async function inspectMemoryRoot(dir) {
  let lstat
  try {
    lstat = await fs.lstat(dir)
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === 'ENOENT') {
      return { exists: false, isDirectory: false, isLink: false }
    }
    throw error
  }
  if (lstat.isSymbolicLink()) return { exists: true, isDirectory: false, isLink: true }
  const stat = await fs.stat(dir).catch(() => undefined)
  return { exists: true, isDirectory: Boolean(stat?.isDirectory()), isLink: false }
}

/**
 * Refuse a directory that would let the plugin write outside the project.
 *
 * @param {string} dir
 */
export async function assertUsableRoot(dir) {
  const info = await inspectMemoryRoot(dir)
  if (info.isLink) {
    throw new MemoryError(CODES.DIR_UNCONFIRMED, '记忆目录是符号链接或 junction，拒绝使用；请配置真实路径', { dir })
  }
  if (!info.exists) {
    throw new MemoryError(CODES.DIR_NOT_FOUND, '记忆目录不存在', { dir })
  }
  if (!info.isDirectory) {
    throw new MemoryError(CODES.DIR_UNCONFIRMED, '记忆目录不是目录', { dir })
  }
}

/**
 * Create the memory directory and an empty index. Only write tools call this.
 *
 * @param {string} dir
 * @returns {Promise<{ created: boolean }>}
 */
export async function createMemoryRoot(dir) {
  const info = await inspectMemoryRoot(dir)
  if (info.isLink) {
    throw new MemoryError(CODES.DIR_UNCONFIRMED, '记忆目录是符号链接或 junction，拒绝创建', { dir })
  }
  if (info.exists) {
    if (!info.isDirectory) throw new MemoryError(CODES.DIR_UNCONFIRMED, '记忆目录位置存在同名文件', { dir })
    const index = path.join(dir, 'MEMORY.md')
    try {
      await fs.access(index)
      return { created: false }
    } catch {
      await fs.writeFile(index, '', 'utf8')
      return { created: false }
    }
  }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'MEMORY.md'), '', 'utf8')
  return { created: true }
}

/**
 * Ensure the state directory is nowhere inside a memory directory.
 *
 * @param {string} stateRoot
 * @param {string} memoryDir
 */
export function assertStateOutsideMemory(stateRoot, memoryDir) {
  if (isInside(memoryDir, stateRoot)) {
    throw new MemoryError(CODES.CONFIG_INVALID, '插件状态目录不能放在共享记忆目录内', { stateRoot, memoryDir })
  }
}

/** Test seam: drop the cached git layout. */
export function resetGitCache() {
  gitCache.clear()
}
