/**
 * Explicit "remember this" / "forget this" detection.
 *
 * This is a nudge, not a classifier: when the user's own words ask for a memory
 * operation, the plugin appends one short instruction so the model reaches for
 * `claude_memory_*` instead of a file tool. False positives cost one line of
 * context; false negatives fall back to the conventions in the baseline.
 */

const REMEMBER_PATTERNS = [/记住/, /记一下/, /记下来/, /记下/, /牢记/, /别忘(了|记)/, /帮我记/, /\bremember\b/i]
const FORGET_PATTERNS = [/忘掉/, /忘记/, /不要再记/, /别再记/, /别记/, /删掉.*记忆/, /\bforget\b/i]

/**
 * @typedef {{ kind: 'remember' | 'forget', term: string }} Intent
 */

/**
 * @param {string} text
 * @returns {Intent | null}
 */
export function detectIntent(text) {
  const value = String(text ?? '')
  if (!value.trim()) return null
  for (const pattern of FORGET_PATTERNS) {
    const match = pattern.exec(value)
    if (match) return { kind: 'forget', term: match[0] }
  }
  for (const pattern of REMEMBER_PATTERNS) {
    const match = pattern.exec(value)
    if (match) return { kind: 'remember', term: match[0] }
  }
  return null
}

/**
 * Extract the text of one user-role message (content is a block array).
 *
 * @param {{ content?: unknown }} message
 * @returns {string}
 */
export function userMessageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Instruction appended when an explicit intent was detected.
 *
 * @param {Intent} intent
 * @param {{ hasIndex: boolean }} state
 * @returns {string}
 */
export function reminderText(intent, state) {
  if (intent.kind === 'forget') {
    return [
      '[Claude-DSH-Memory] 用户要求忘记某条记忆。',
      '先用 `claude_memory_search` / `claude_memory_manifest` 定位唯一目标，再 `claude_memory_read` 取得 revision，',
      '然后调用 `claude_memory_forget`（带 expected_revision）。多目标或指向不明时先向用户澄清，不要批量删除。',
    ].join('')
  }
  if (!state.hasIndex) {
    return '[Claude-DSH-Memory] 用户要求记住某些信息。当前项目还没有记忆索引；请用 `claude_memory_write`（action=create）写入，一条记忆一个文件。'
  }
  return [
    '[Claude-DSH-Memory] 用户要求记住某些信息。',
    '先 `claude_memory_search` 查重：已有条目用 `claude_memory_write`（action=update，带 expected_revision，body 传完整正文），',
    '没有则用 action=create；不要用文件工具直接改记忆目录。',
  ].join('')
}
