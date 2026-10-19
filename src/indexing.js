/**
 * `MEMORY.md` pointer maintenance and budget-aware rendering.
 *
 * A pointer is a single Markdown list line:
 *
 *     - [Title](file.md) — one-line description
 *
 * Both separators Claude has produced are accepted (`—` and ` - `). Lines that
 * are not pointers — headings, blank lines, hand-written notes — are never
 * rewritten.
 */

import { CODES, MemoryError } from './errors.js'

const LINK_PATTERN = /\[[^\]]*\]\(([^)]+\.md)\)/
const LEADING_FRONTMATTER_PATTERN = /^---\s*\r?\n[\s\S]*?^---\s*(\r?\n)?/m

/**
 * @typedef {{ filename: string, title: string, description: string, line: string }} IndexPointer
 */

/**
 * @param {string} line
 * @returns {IndexPointer | null}
 */
export function parsePointer(line) {
  const link = LINK_PATTERN.exec(line)
  if (!link) return null
  const filename = link[1].trim()
  const titleMatch = /\[([^\]]+)\]/.exec(line)
  const title = titleMatch ? titleMatch[1] : filename
  /** @type {string} */
  let description = ''
  const dashIndex = line.indexOf('—')
  if (dashIndex >= 0) {
    description = line.slice(dashIndex + 1).trim()
  } else {
    const spacedDash = line.indexOf(' - ')
    if (spacedDash >= 0) description = line.slice(spacedDash + 3).trim()
  }
  return { filename, title, description, line }
}

/**
 * @param {string} title
 * @param {string} filename
 * @param {string} description
 * @returns {string}
 */
export function pointerLine(title, filename, description) {
  const cleanTitle = (title.trim() || filename.replace(/\.md$/i, ''))
    .replace(/\[/g, '（')
    .replace(/\]/g, '）')
    .replace(/[\r\n]/g, ' ')
  const cleanFilename = filename.replace(/\\/g, '/').replace(/^\/+/, '')
  const cleanDescription = description.trim().replace(/[\r\n]+/g, ' ')
  return `- [${cleanTitle}](${cleanFilename}) — ${cleanDescription}`.trimEnd()
}

/**
 * Insert or replace the pointer for one file, keeping its position when it
 * already exists.
 *
 * @param {string} text current `MEMORY.md` contents (may be empty).
 * @param {{ filename: string, title: string, description: string }} entry
 * @returns {string}
 */
export function updateIndexText(text, entry) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const replacement = pointerLine(entry.title, entry.filename, entry.description)
  const wanted = entry.filename.replace(/\\/g, '/')

  for (let index = 0; index < lines.length; index += 1) {
    const pointer = parsePointer(lines[index])
    if (pointer && pointer.filename.replace(/\\/g, '/') === wanted) {
      lines[index] = replacement
      return `${lines.join(newline)}${newline}`
    }
  }
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
  lines.push(replacement)
  // No `# Memory Index` heading is added for an empty file (D2): the real
  // Claude memory indexes carry no heading.
  return `${lines.join(newline)}${newline}`
}

/**
 * @param {string} text
 * @param {{ filename: string }} entry
 * @returns {string}
 */
export function removeIndexText(text, entry) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const wanted = entry.filename.replace(/\\/g, '/')
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const kept = lines.filter((line) => {
    const pointer = parsePointer(line)
    return !(pointer && pointer.filename.replace(/\\/g, '/') === wanted)
  })
  const joined = kept.join(newline).replace(/[\s\uFEFF]+$/, '')
  return joined ? `${joined}${newline}` : ''
}

/**
 * Undo the pointer edits of {@link updateIndexText}; `applied` is the text the
 * successful edit produced, `previous` the text it replaced.
 *
 * @param {string} current
 * @param {string} applied
 * @param {string} previous
 * @returns {string} the previous text, or `current` when it was edited again.
 */
export function revertIndexText(current, applied, previous) {
  return current === applied ? previous : current
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function indexTargets(text) {
  /** @type {Set<string>} */
  const targets = new Set()
  for (const line of text.split(/\r\n|\n|\r/)) {
    const pointer = parsePointer(line)
    if (pointer) targets.add(pointer.filename.replace(/\\/g, '/'))
  }
  return targets
}

/**
 * Render the index for injection, honoring both budgets.
 *
 * @param {string} text
 * @param {{ maxLines: number, maxChars: number }} budget
 * @returns {{ text: string, truncated: boolean, totalLines: number, totalChars: number }}
 */
export function formatIndexForContext(text, budget) {
  const withoutFrontmatter = text.replace(LEADING_FRONTMATTER_PATTERN, '')
  const trimmed = withoutFrontmatter.trim()
  if (!trimmed) return { text: '', truncated: false, totalLines: 0, totalChars: 0 }

  const lines = trimmed.split(/\r\n|\n|\r/)
  const lineTruncated = lines.length > budget.maxLines
  const charTruncated = trimmed.length > budget.maxChars
  if (!lineTruncated && !charTruncated) {
    return { text: trimmed, truncated: false, totalLines: lines.length, totalChars: trimmed.length }
  }

  let truncated = lineTruncated ? lines.slice(0, budget.maxLines).join('\n') : trimmed
  if (truncated.length > budget.maxChars) {
    const cut = truncated.lastIndexOf('\n', budget.maxChars)
    truncated = truncated.slice(0, cut > 0 ? cut : budget.maxChars)
  }
  const suffix = `\n\n> 索引超出注入预算（${lines.length} 行 / ${trimmed.length} 字符），仅显示部分；请用 claude_memory_search 检索完整内容。`
  return {
    text: `${truncated}${suffix}`,
    truncated: true,
    totalLines: lines.length,
    totalChars: trimmed.length,
  }
}

/**
 * Validate a model-facing relative filename. Only the first level of the memory
 * directory is addressable (`sub/dir.md` is rejected) to keep escaping
 * impossible and to match how Claude writes these files.
 *
 * @param {string} filename
 * @returns {string} normalized `name.md`
 */
export function validateFilename(filename) {
  const value = String(filename ?? '').trim().replace(/\\/g, '/')
  if (!value) throw new MemoryError(CODES.INVALID_FILENAME, 'filename 不能为空')
  if (value.includes('/')) {
    throw new MemoryError(CODES.INVALID_FILENAME, 'filename 只能是记忆目录下的文件名，不能含路径分隔符', { received: value })
  }
  if (value.startsWith('.') || value.includes(':')) {
    throw new MemoryError(CODES.INVALID_FILENAME, 'filename 不允许隐藏文件或盘符', { received: value })
  }
  if (/[\r\n[\]()]/.test(value)) {
    throw new MemoryError(CODES.INVALID_FILENAME, 'filename 不允许换行或 Markdown 链接字符', { received: value })
  }
  if (!value.toLowerCase().endsWith('.md')) {
    throw new MemoryError(CODES.INVALID_FILENAME, 'filename 必须以 .md 结尾', { received: value })
  }
  if (value.length > 128) {
    throw new MemoryError(CODES.INVALID_FILENAME, 'filename 过长（上限 128 字符）', { received: value })
  }
  const stem = value.slice(0, -3)
  if (!/^[^<>:"/\\|?*\u0000-\u001f]+$/.test(stem)) {
    throw new MemoryError(CODES.INVALID_FILENAME, 'filename 含非法字符', { received: value })
  }
  if (value.toLowerCase() === 'memory.md') {
    throw new MemoryError(CODES.INVALID_FILENAME, 'MEMORY.md 只能由索引维护逻辑修改', { received: value })
  }
  return value
}

/**
 * Derive a stable filename from a memory name or its description.
 *
 * @param {string} value
 * @returns {string} filename including the `.md` suffix.
 */
export function slugifyFilename(value) {
  const source = String(value ?? '').trim()
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (slug && /^[\x00-\x7f]+$/.test(source)) return `${slug}.md`
  // Non-ASCII names keep any ASCII prefix and add a short content hash so the
  // filename stays unique and filesystem-safe.
  const suffix = createHashSuffix(source)
  return `${slug || 'memory'}-${suffix}.md`
}

/**
 * @param {string} value
 * @returns {string}
 */
function createHashSuffix(value) {
  // Small FNV-1a: stable across processes and cheap; not used for security.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
