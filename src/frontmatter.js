/**
 * Minimal, preservation-first YAML frontmatter handling for Claude memory files.
 *
 * Only four fields are ever interpreted (`name`, `description`, `type` at the
 * top level and `metadata.type`); every other line — including nested keys the
 * reference implementation does not know about — is kept byte-for-byte. When a
 * file cannot be understood safely the caller is told to refuse the write
 * instead of rewriting it (`CM_FRONTMATTER_INVALID`).
 *
 * Deviations from the upstream memory format, both deliberate:
 *  - no `modified` timestamp is added (D1);
 *  - a brand-new file gets Claude Code's own shape, `metadata: { type: … }`,
 *    instead of a top-level `type:` key (D11), and an existing file keeps
 *    whichever location it already uses.
 */

import { CODES, MemoryError } from './errors.js'

export const TYPE_VALUES = Object.freeze(['user', 'feedback', 'project', 'reference'])

/** @typedef {(typeof TYPE_VALUES)[number]} MemoryType */

/**
 * @typedef {object} MemoryDocument
 * @property {string} filename
 * @property {string | null} name
 * @property {string | null} description
 * @property {string | null} type
 * @property {string | null} nodeType
 * @property {string | null} originSessionId
 * @property {string} body
 * @property {string} rawText
 * @property {boolean} hasFrontmatter
 * @property {boolean} bom
 * @property {string} newline
 */

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string} text
 * @returns {{ newline: string, lines: string[] }}
 */
function splitLines(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { newline, lines }
}

/**
 * Locate the opening/closing `---` fence.
 *
 * @param {string[]} lines
 * @returns {{ start: number, end: number } | null}
 */
function findFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return { start: 0, end: index }
  }
  return null
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const text = value.trim()
  if (text.length >= 2 && text[0] === text[text.length - 1] && (text[0] === "'" || text[0] === '"')) {
    const inner = text.slice(1, -1)
    if (text[0] === '"') {
      try {
        return JSON.parse(text)
      } catch {
        return inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    }
    return inner.replace(/''/g, "'")
  }
  if (text === 'null' || text === '~') return ''
  return text
}

/**
 * JSON strings are valid YAML double-quoted scalars and avoid every ambiguity
 * (colons, leading `-`, booleans and numbers).
 *
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return JSON.stringify(value)
}

/**
 * @param {string} name
 * @returns {string}
 */
export function validateName(name) {
  const value = String(name ?? '').trim()
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MemoryError(CODES.INTERNAL, '记忆 name 必须是 1-200 字符的单行文本')
  }
  return value
}

/**
 * @param {string} description
 * @returns {string}
 */
export function validateDescription(description) {
  const value = String(description ?? '').trim()
  if (!value) throw new MemoryError(CODES.INTERNAL, 'description 不能为空')
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new MemoryError(CODES.INTERNAL, 'description 必须是单行文本')
  }
  return value
}

/**
 * @param {string} type
 * @returns {MemoryType}
 */
export function validateType(type) {
  const value = String(type ?? '').trim()
  if (!TYPE_VALUES.includes(/** @type {MemoryType} */ (value))) {
    throw new MemoryError(CODES.INVALID_TYPE, `记忆 type 必须是 ${TYPE_VALUES.join('、')} 之一`, { received: value })
  }
  return /** @type {MemoryType} */ (value)
}

/**
 * Parse one memory file. Never throws: an unreadable frontmatter degrades to
 * "no frontmatter" semantics, and the caller refuses writes based on
 * {@link assertWritable}.
 *
 * @param {string} text
 * @param {string} filename
 * @returns {MemoryDocument}
 */
export function parseDocument(text, filename = 'memory.md') {
  const bom = text.charCodeAt(0) === 0xfeff
  const raw = bom ? text.slice(1) : text
  const { newline, lines } = splitLines(raw)
  /** @type {MemoryDocument} */
  const doc = {
    filename,
    name: null,
    description: null,
    type: null,
    nodeType: null,
    originSessionId: null,
    body: raw.trim(),
    rawText: raw,
    hasFrontmatter: false,
    bom,
    newline,
  }
  const bounds = findFrontmatter(lines)
  if (bounds === null) return doc

  doc.hasFrontmatter = true
  /** @type {number | null} */
  let metadataIndent = null
  for (const rawLine of lines.slice(bounds.start + 1, bounds.end)) {
    if (!rawLine.trim()) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const stripped = rawLine.trim()
    const colon = stripped.indexOf(':')
    if (colon < 0) continue
    const key = stripped.slice(0, colon).trim()
    const value = stripped.slice(colon + 1).trim()
    if (metadataIndent !== null && indent > metadataIndent) {
      if (key === 'type') doc.type = unquote(value) || null
      else if (key === 'node_type') doc.nodeType = unquote(value) || null
      else if (key === 'originSessionId') doc.originSessionId = unquote(value) || null
      continue
    }
    metadataIndent = key === 'metadata' ? indent : null
    if (key === 'name') doc.name = unquote(value) || null
    else if (key === 'description') doc.description = unquote(value) || null
    else if (key === 'type') doc.type = unquote(value) || null
  }

  // A top-level `type` outranks a legacy `metadata.type`.
  for (const rawLine of lines.slice(bounds.start + 1, bounds.end)) {
    if (rawLine.startsWith('type:')) doc.type = unquote(rawLine.slice(rawLine.indexOf(':') + 1)) || null
  }

  const bodyLines = lines.slice(bounds.end + 1)
  if (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift()
  doc.body = bodyLines.join('\n').trim()
  return doc
}

/**
 * @param {string[]} lines frontmatter body lines (without the fences).
 * @param {string} key
 * @param {string} value
 */
function setScalar(lines, key, value) {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!pattern.test(lines[index])) continue
    let end = index + 1
    // Replace a block scalar / nested continuation wholesale, leaving other keys alone.
    while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end += 1
    lines.splice(index, end - index, `${key}: ${quote(value)}`)
    return
  }
  const metadataIndex = lines.findIndex((line) => line.trim() === 'metadata:')
  const insertAt = metadataIndex < 0 ? lines.length : metadataIndex
  lines.splice(insertAt, 0, `${key}: ${quote(value)}`)
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @param {string} value
 */
function setMetadataScalar(lines, key, value) {
  const metadataIndex = lines.findIndex((line) => line.trim() === 'metadata:')
  if (metadataIndex < 0) {
    lines.push('metadata:', `  ${key}: ${quote(value)}`)
    return
  }
  let blockEnd = lines.length
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() && !/^[ \t]/.test(line)) {
      blockEnd = index
      break
    }
  }
  const pattern = new RegExp(`^\\s+${escapeRegExp(key)}\\s*:`)
  for (let index = metadataIndex + 1; index < blockEnd; index += 1) {
    if (pattern.test(lines[index])) {
      lines[index] = `  ${key}: ${quote(value)}`
      return
    }
  }
  lines.splice(blockEnd, 0, `  ${key}: ${quote(value)}`)
}

/**
 * @param {string[]} lines
 * @param {string} key
 * @returns {boolean}
 */
function hasMetadataKey(lines, key) {
  const metadataIndex = lines.findIndex((line) => line.trim() === 'metadata:')
  if (metadataIndex < 0) return false
  const pattern = new RegExp(`^\\s+${escapeRegExp(key)}\\s*:`)
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() && !/^[ \t]/.test(line)) return false
    if (pattern.test(line)) return true
  }
  return false
}

/**
 * Throw when an existing file must not be rewritten automatically.
 *
 * @param {string} text
 * @param {string} filename
 */
export function assertWritable(text, filename) {
  const bom = text.charCodeAt(0) === 0xfeff
  const raw = bom ? text.slice(1) : text
  const { lines } = splitLines(raw)
  if (lines.length > 0 && lines[0].trim() === '---' && findFrontmatter(lines) === null) {
    throw new MemoryError(CODES.FRONTMATTER_INVALID, `已有 frontmatter 未闭合，拒绝自动改写：${filename}`, { filename })
  }
}

/**
 * Render a memory document, preserving every unmanaged frontmatter line.
 *
 * @param {{
 *   existingText?: string | null,
 *   filename: string,
 *   name: string,
 *   description: string,
 *   type: string,
 *   body: string,
 * }} input
 * @returns {string}
 */
export function renderDocument(input) {
  const name = validateName(input.name)
  const description = validateDescription(input.description)
  const type = validateType(input.type)
  const body = String(input.body ?? '').trim()
  if (!body) throw new MemoryError(CODES.BODY_EMPTY, 'body 不能为空')
  const filename = input.filename

  const existingText = input.existingText ?? ''
  const bom = existingText.charCodeAt(0) === 0xfeff
  const raw = bom ? existingText.slice(1) : existingText
  const { newline, lines } = splitLines(raw)
  const bounds = findFrontmatter(lines)
  assertWritable(existingText, filename)

  /** @type {string[]} */
  const frontLines = bounds === null ? [] : lines.slice(bounds.start + 1, bounds.end)
  const topLevelType = frontLines.some((line) => line.startsWith('type:'))
  const metadataType = hasMetadataKey(frontLines, 'type')

  setScalar(frontLines, 'name', name)
  setScalar(frontLines, 'description', description)
  if (topLevelType) setScalar(frontLines, 'type', type)
  if (metadataType) setMetadataScalar(frontLines, 'type', type)
  if (!topLevelType && !metadataType) setMetadataScalar(frontLines, 'type', type)

  const bodyLines = body.split(/\r\n|\n|\r/)
  const newLines = ['---', ...frontLines, '---', '', ...bodyLines]
  return `${bom ? '\uFEFF' : ''}${newLines.join(newline)}${newline}`
}

/**
 * Metadata snapshot used by the manifest, the search index and the injection.
 *
 * @param {string} text
 * @param {string} filename
 * @returns {{ filename: string, name: string, description: string, type: string|null, body: string, revision: string }}
 */
export function summarizeDocument(text, filename) {
  const doc = parseDocument(text, filename)
  const stem = filename.replace(/^.*\//, '').replace(/\.md$/i, '')
  const description = (doc.description ?? doc.body.split('\n')[0] ?? '').trim()
  return {
    filename,
    name: doc.name ?? stem,
    description: description.length > 200 ? `${description.slice(0, 199)}…` : description,
    type: doc.type,
    body: doc.body,
    revision: '',
  }
}
