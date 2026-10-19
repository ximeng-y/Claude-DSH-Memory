/**
 * Deterministic lexical search over memory files.
 *
 * Terms are split on Unicode whitespace (including the full-width space), the
 * match is case-insensitive, and any single term is enough to return an entry
 * (OR). Weights:
 *
 *     name 6, description 3, body 1
 *
 * No stemming, no Chinese segmentation, no embeddings.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { CODES, MemoryError } from './errors.js'

/**
 * @param {string} query
 * @returns {string[]} unique lowercase terms, longest first is NOT applied — the
 *   original order is kept so snippets stay predictable.
 */
export function tokenize(query) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/[\s\u3000]+/)
    .map((term) => term.trim())
    .filter(Boolean)
  return [...new Set(terms)]
}

/**
 * @param {{ name: string, description: string, body: string }} entry
 * @param {string[]} terms
 * @returns {{ score: number, matched: string[] }}
 */
export function scoreEntry(entry, terms) {
  const name = entry.name.toLowerCase()
  const description = entry.description.toLowerCase()
  const body = entry.body.toLowerCase()
  let score = 0
  /** @type {string[]} */
  const matched = []
  for (const term of terms) {
    let hit = 0
    if (name.includes(term)) hit += 6
    if (description.includes(term)) hit += 3
    if (body.includes(term)) hit += 1
    if (hit === 0) continue
    matched.push(term)
    score += hit
  }
  return { score, matched }
}

/**
 * First line of the body containing the most specific term, clipped to 200
 * characters and wrapped in `…` when something was cut.
 *
 * @param {string} body
 * @param {string[]} terms
 * @returns {string}
 */
export function buildSnippet(body, terms) {
  const lines = body.split(/\r\n|\n|\r/)
  for (const term of terms) {
    const line = lines.find((candidate) => candidate.toLowerCase().includes(term))
    if (line !== undefined) return clipSnippet(line)
  }
  const first = lines.find((line) => line.trim().length > 0) ?? ''
  return clipSnippet(first)
}

/**
 * @param {string} line
 * @returns {string}
 */
function clipSnippet(line) {
  const trimmed = line.trim()
  if (trimmed.length <= 200) return trimmed
  return `${trimmed.slice(0, 199)}…`
}

/**
 * @param {import('./store.js').MemoryStore} store
 * @param {{ query: string, types?: string[] | null, limit?: number }} options
 * @returns {Promise<{ results: Array<{ filename: string, name: string, description: string, type: string|null, score: number, snippet: string }>, total: number, query: string }>}
 */
export async function searchMemory(store, options) {
  const query = String(options.query ?? '').trim()
  if (!query) throw new MemoryError(CODES.QUERY_EMPTY, 'query 不能为空')
  const terms = tokenize(query)
  if (terms.length === 0) throw new MemoryError(CODES.QUERY_EMPTY, 'query 不能为空')
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
  const types = Array.isArray(options.types) && options.types.length > 0 ? new Set(options.types) : null

  const { entries } = await store.manifest({ limit: 10000 })
  /** @type {Array<{ filename: string, name: string, description: string, type: string|null, score: number, snippet: string, mtimeMs: number }>} */
  const hits = []
  for (const entry of entries) {
    if (types !== null && (entry.type === null || !types.has(entry.type))) continue
    const text = await fs.readFile(path.join(store.root, entry.filename), 'utf8').catch(() => '')
    const body = text.replace(/^---[\s\S]*?\n---\s*(\r?\n)?/, '')
    const { score, matched } = scoreEntry({ name: entry.name, description: entry.description, body }, terms)
    if (matched.length === 0) continue
    hits.push({
      filename: entry.filename,
      name: entry.name,
      description: entry.description,
      type: entry.type,
      score,
      snippet: buildSnippet(body, matched),
      mtimeMs: entry.mtimeMs,
    })
  }
  hits.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename))
  return {
    results: hits.slice(0, limit).map(({ mtimeMs: _mtimeMs, ...rest }) => rest),
    total: hits.length,
    query,
  }
}
