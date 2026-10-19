/**
 * Baseline injection text.
 *
 * The index is a session-level snapshot delivered once as a user-role message
 * It is not a system prompt
 * section: the index changes between sessions and would invalidate the prompt
 * prefix cache on every edit.
 */

export const SOURCE_KIND = 'claude-memory'

const CONVENTIONS = [
  '主动识别值得长期保存的信息：稳定偏好、重要纠正、已确认决定、可复用经验；不要只等用户说"记住"。',
  '写入前先用 `claude_memory_search` / `claude_memory_read` 查重，优先更新已有条目。',
  '一条记忆一个文件；`MEMORY.md` 只是索引，不要把它当正文写。',
  '更新用 `claude_memory_write`（action=update，带 expected_revision），`body` 传完整正文；冲突时重新读取，不要拿旧正文盲重试。',
  '删除只在用户明确授权后，用 `claude_memory_forget` 并对准唯一目标；多目标先澄清。',
  '类型：user（用户身份/偏好）、feedback（对工作方式的纠正）、project（无法从代码推导的项目约束）、reference（外部资源）。',
  '不保存：密钥/令牌、临时任务状态、可从代码或 Git 推导的事实、未验证的推测。',
  '记忆目录在 DSH 会话内**禁止直接用文件工具修改**；写文件会被拒绝，请改用上述工具。',
]

const EXAMPLE_LINE = 'feedback/project 条目正文建议包含 `**Why:**` 与 `**How to apply:**`。'

/**
 * @param {{
 *   memoryDir: string | null,
 *   unconfirmed?: boolean,
 *   indexText?: string,
 *   indexTruncated?: boolean,
 *   autoExtract?: boolean,
 *   guardEnabled?: boolean,
 *   extractionNote?: boolean,
 *   warnings?: string[],
 *   maxChars: number,
 * }} input
 * @returns {string}
 */
export function buildBaseline(input) {
  const maxChars = Math.max(400, input.maxChars)
  const lines = ['# Claude-DSH-Memory', '']
  if (input.memoryDir === null) {
    lines.push('本会话**未**共享 Claude Code 的项目记忆：无法确定本项目的记忆目录。')
    lines.push('如需启用，请在插件配置 `projectMemoryDirs` 中显式映射，或先在本项目中用 Claude Code 建立记忆。')
  } else {
    lines.push(`本会话共享 Claude Code 的项目记忆目录：\`${input.memoryDir}\``)
    if (input.unconfirmed) {
      lines.push('该目录由插件按路径规则推断/创建，尚未在 Claude Code 中核对；如与 Claude 实际使用的目录不一致，请配置 `projectMemoryDirs`。')
    }
    if (input.extractionNote === true) {
      lines.push('本会话结束后会做一次后台记忆提取（只补录、不删除；可在插件配置中关闭）。')
    }
    if (input.warnings && input.warnings.length > 0) {
      lines.push(`> ${input.warnings[0]}`)
    }
  }
  lines.push('')
  lines.push('## 维护约定')
  lines.push('')
  for (const bullet of CONVENTIONS) lines.push(`- ${bullet}`)

  /** @type {string[]} */
  const exampleLines = []
  if (input.guardEnabled !== false) exampleLines.push(`- ${EXAMPLE_LINE}`)

  const indexSection = input.memoryDir === null ? '' : formatIndexSection(input.indexText ?? '')
  const assemble = (/** @type {string[]} */ examples) => {
    const body = [...lines, ...examples, '']
    if (input.memoryDir !== null) {
      body.push('## 当前项目 MEMORY.md', '', indexSection || '当前项目还没有记忆索引。', '')
    }
    return body.join('\n').trimEnd()
  }

  let text = assemble(exampleLines)
  if (text.length <= maxChars) return text

  // Budget order: drop the optional example first, then cut the index tail.
  text = assemble([])
  if (text.length <= maxChars) return text

  const overhead = text.length - indexSection.length
  const available = Math.max(200, maxChars - overhead - 120)
  if (indexSection.length > available) {
    const cut = indexSection.slice(0, available)
    const note = `\n\n> 索引超出注入预算，仅显示部分；请用 claude_memory_search 检索完整内容。`
    text = assemble([]).replace(indexSection, `${cut}${note}`)
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars - 40).trimEnd()}\n\n> （注入已按预算截断）`
  }
  return text
}

/**
 * @param {string} indexText
 * @returns {string}
 */
function formatIndexSection(indexText) {
  return indexText.trim()
}

/**
 * One-line diagnosis used when the plugin cannot inject a full baseline.
 *
 * @param {string} reason
 * @returns {string}
 */
export function buildDiagnosis(reason) {
  return [
    '# Claude-DSH-Memory',
    '',
    `未能注入 Claude Code 项目记忆：${reason}`,
    '如需启用，请配置插件参数 `projectMemoryDirs`（项目绝对路径 → 记忆目录绝对路径）。',
  ].join('\n')
}

/**
 * The message payload passed to `agent.inject()`.
 *
 * `source.kind` is free-form at runtime (the Host itself uses
 * `runtime-context`), so the plugin can tag its own injections and detect them
 * again on resume through `session.deriveMessages()`.
 *
 * @param {string} text
 * @param {string} id
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: string, form: 'snapshot' } }}
 */
export function buildInjectionMessage(text, id) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'snapshot' },
  }
}
