/**
 * The eight `claude_memory_*` tools.
 *
 * Every tool resolves the project from the calling session — there is no
 * `project_root` parameter, so a model cannot point the plugin at another
 * project's memory. Tools never throw for ordinary failures: they raise
 * `MemoryError`, whose message starts with the documented code, and the Host
 * materializes that as an error result.
 */

import { CODES, MemoryError } from './errors.js'
import { searchMemory } from './search.js'
import { MEMORY_TYPES } from './config.js'

/** @typedef {{ render: (args: unknown, value: import('node:util').JsonValue) => Array<{ type: 'text', text: string }> }} ToolOutput */

/**
 * @param {unknown} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * @param {unknown} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderText(value) {
  const text = /** @type {{ text?: string }} */ (value)?.text
  return [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(value, null, 2) }]
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function raise(code, message, details) {
  throw new MemoryError(code, message, details)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) raise(CODES.INTERNAL, `${name} 必须是非空字符串`)
  return value.trim()
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string | null}
 */
function optionalString(value, name) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') raise(CODES.INTERNAL, `${name} 必须是字符串`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function optionalStringArray(value, name) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) raise(CODES.INTERNAL, `${name} 必须是字符串数组`)
  return value.map((entry) => requireString(entry, name))
}

/**
 * Build every tool definition.
 *
 * @param {{
 *   runtime: import('./runtime.js').MemoryRuntime,
 *   cwdFor: (exec: { agent?: { id: string } } | undefined) => string,
 * }} deps
 * @returns {Array<Record<string, unknown>>}
 */
export function createMemoryTools(deps) {
  const { runtime, cwdFor } = deps

  return [
    {
      name: 'claude_memory_status',
      description:
        '报告当前项目共享的 Claude Code 记忆目录状态：解析到的目录、是否已核对、索引与条目数、类型分布、提取与保护计数。排查“记忆到底写到哪里”时先调用它。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            memoryDir: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            confirmed: { type: 'boolean' },
            exists: { type: 'boolean' },
            entries: { type: 'number' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        return runtime.status(cwdFor(exec))
      },
    },

    {
      name: 'claude_memory_index',
      description:
        '读取当前项目 MEMORY.md 索引（受注入预算限制）。返回的 text 是索引原文；truncated 为 true 表示超出预算被截断。需要逐条内容时用 claude_memory_manifest 或 claude_memory_search。',
      parameters: {
        type: 'object',
        properties: {
          maxLines: { type: 'number', description: '最多返回多少行，默认 200。' },
          maxChars: { type: 'number', description: '最多返回多少字符，默认 12000。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            truncated: { type: 'boolean' },
            totalLines: { type: 'number' },
            bytes: { type: 'number' },
          },
        },
        render: (_args, value) => renderText(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const { store, resolved } = await runtime.store(cwd)
        const budgets = {
          maxLines: typeof args?.maxLines === 'number' ? args.maxLines : runtime.config.indexMaxLines,
          maxChars: typeof args?.maxChars === 'number' ? args.maxChars : runtime.config.indexMaxChars,
        }
        const raw = await store.readIndexText()
        const formatted = await store.formattedIndex()
        const limited = formatWithBudget(raw, budgets)
        return {
          memoryDir: resolved.dir,
          text: limited.text || formatted.text,
          truncated: limited.truncated || formatted.truncated,
          totalLines: limited.totalLines,
          bytes: Buffer.byteLength(raw, 'utf8'),
        }
      },
    },

    {
      name: 'claude_memory_manifest',
      description:
        '列出当前项目所有记忆条目的元数据（文件名、name、description、type、大小、修改时间），并标出 indexed=false 的“孤儿条目”（文件存在但 MEMORY.md 没有指针）。检索前先看清单可以避免重复创建。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数上限，默认 100，最大 1000。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  type: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  bytes: { type: 'number' },
                  indexed: { type: 'boolean' },
                },
              },
            },
            total: { type: 'number' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const { store } = await runtime.store(cwd)
        const limit = typeof args?.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 1000) : 100
        const manifest = await store.manifest({ limit })
        return manifest
      },
    },

    {
      name: 'claude_memory_search',
      description:
        '按关键词检索当前项目的记忆条目（大小写不敏感，任一词命中即返回，按 name/description/正文加权排序）。写入前必须先用它查重，优先更新已有条目而不是新建。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，按空白分词；中文整词匹配。' },
          types: {
            type: 'array',
            description: '只返回这些类型的条目。',
            items: { type: 'string', enum: [...MEMORY_TYPES] },
          },
          limit: { type: 'number', description: '返回条数上限，默认 20，最大 100。' },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filename: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  type: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  score: { type: 'number' },
                  snippet: { type: 'string' },
                },
              },
            },
            total: { type: 'number' },
            query: { type: 'string' },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const { store } = await runtime.store(cwd)
        const query = requireString(args?.query, 'query')
        return searchMemory(store, {
          query,
          types: optionalStringArray(args?.types, 'types'),
          limit: typeof args?.limit === 'number' ? args.limit : 20,
        })
      },
    },

    {
      name: 'claude_memory_read',
      description:
        '读取一条记忆的完整内容，并返回它的 revision。更新或删除前必须先读：revision 用于 expected_revision 冲突检测。用 filename 精确定位，或用 name 唯一匹配（多条命中会报 CM_AMBIGUOUS_NAME）。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '记忆文件名，例如 build-commands.md。' },
          name: { type: 'string', description: '记忆的 name 字段；必须唯一。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            type: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            body: { type: 'string' },
            revision: { type: 'string' },
            bytes: { type: 'number' },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const { store } = await runtime.store(cwd)
        const filename = optionalString(args?.filename, 'filename')
        const name = optionalString(args?.name, 'name')
        if (filename === null && name === null) raise(CODES.INTERNAL, '必须提供 filename 或 name')
        const entry = await store.read({ filename, name })
        return entry
      },
    },

    {
      name: 'claude_memory_write',
      description:
        '创建或更新一条项目记忆，并同步维护 MEMORY.md 索引。action=create 新建（已存在则报错）、update 更新已有（必须带 expected_revision）、upsert 两者兼容。body 是完整正文而不是补丁；不要用 write/edit 工具直接改记忆目录，会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'upsert'], description: '写入动作。' },
          filename: { type: 'string', description: '目标文件名；缺省时由 name 推导。' },
          name: { type: 'string', description: '记忆 name（1-200 字符，单行）。新建时必填。' },
          description: { type: 'string', description: '一句话描述，写进索引的行尾。' },
          type: { type: 'string', enum: [...MEMORY_TYPES], description: '记忆类型。' },
          body: { type: 'string', description: '完整正文（Markdown），不是 diff。' },
          title: { type: 'string', description: '索引里显示的名字，缺省用 name。' },
          expected_revision: { type: 'string', description: 'update/upsert 已有条目时必填，来自 claude_memory_read。' },
        },
        required: ['action', 'description', 'type', 'body'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            filename: { type: 'string' },
            revision: { type: 'string' },
            indexUpdated: { type: 'boolean' },
            bytes: { type: 'number' },
            warning: { type: 'string' },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const store = await runtime.writableStore(cwd)
        const action = requireString(args?.action, 'action').toLowerCase()
        if (!['create', 'update', 'upsert'].includes(action)) raise(CODES.INTERNAL, 'action 必须是 create、update 或 upsert')
        const type = requireString(args?.type, 'type')
        if (!MEMORY_TYPES.includes(type)) raise(CODES.INVALID_TYPE, `type 必须是 ${MEMORY_TYPES.join('、')} 之一`, { received: type })
        const description = requireString(args?.description, 'description')
        const body = requireString(args?.body, 'body')
        const name = optionalString(args?.name, 'name')
        const filename = optionalString(args?.filename, 'filename')
        const title = optionalString(args?.title, 'title')
        const expectedRevision = optionalString(args?.expected_revision, 'expected_revision')
        if (action === 'create' && name === null && filename === null) {
          raise(CODES.INTERNAL, 'create 必须提供 name 或 filename')
        }
        const result = await store.write({
          action,
          filename,
          name,
          description,
          type,
          body,
          title,
          expectedRevision,
        })
        runtime.dropCache(cwd)
        runtime.logger.info(`memory ${result.action}`, result.filename, `${result.bytes}B`)
        return result
      },
    },

    {
      name: 'claude_memory_forget',
      description:
        '把一条记忆移入插件私有回收目录（永不真正删除），并从 MEMORY.md 索引移除。必须带 expected_revision；目标必须唯一，多目标时先向用户澄清，不做批量删除。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '要移除的记忆文件名。' },
          name: { type: 'string', description: '或按 name 定位（必须唯一）。' },
          expected_revision: { type: 'string', description: '来自 claude_memory_read 的 revision。' },
          reason: { type: 'string', description: '移除原因，写入 journal。' },
        },
        required: ['expected_revision'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            trashedTo: { type: 'string' },
            indexUpdated: { type: 'boolean' },
            warning: { type: 'string' },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const store = await runtime.writableStore(cwd)
        const filename = optionalString(args?.filename, 'filename')
        const name = optionalString(args?.name, 'name')
        if (filename === null && name === null) raise(CODES.INTERNAL, '必须提供 filename 或 name')
        const expectedRevision = requireString(args?.expected_revision, 'expected_revision')
        const result = await store.forget({
          filename,
          name,
          expectedRevision,
          reason: optionalString(args?.reason, 'reason'),
        })
        runtime.dropCache(cwd)
        runtime.logger.info('memory forgotten', result.filename)
        return result
      },
    },

    {
      name: 'claude_memory_repair_index',
      description:
        '核对 MEMORY.md 与磁盘上的记忆文件：补齐缺失的指针、删除指向不存在文件的指针、刷新描述漂移的行。默认 dryRun=true 只报告变更；dryRun=false 会先备份索引再写入。',
      parameters: {
        type: 'object',
        properties: {
          dryRun: { type: 'boolean', description: '默认 true，只报告不写入。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            applied: { type: 'boolean' },
            changes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['add', 'remove', 'update'] },
                  filename: { type: 'string' },
                  line: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => renderJson(value),
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const cwd = cwdFor(exec)
        const store = await runtime.writableStore(cwd)
        const dryRun = args?.dryRun === undefined ? true : Boolean(args.dryRun)
        const result = await store.repairIndex({ dryRun })
        if (!dryRun && result.applied) {
          runtime.dropCache(cwd)
          runtime.logger.info('index repaired', `${result.changes.length} changes`)
        }
        return result
      },
    },
  ]
}

/**
 * Apply explicit per-call budgets on top of the configured ones.
 *
 * @param {string} text
 * @param {{ maxLines: number, maxChars: number }} budget
 * @returns {{ text: string, truncated: boolean, totalLines: number }}
 */
function formatWithBudget(text, budget) {
  const trimmed = text.trim()
  if (!trimmed) return { text: '', truncated: false, totalLines: 0 }
  const lines = trimmed.split(/\r\n|\n|\r/)
  const maxLines = Math.max(1, Math.trunc(budget.maxLines) || 200)
  const maxChars = Math.max(1, Math.trunc(budget.maxChars) || 12000)
  const lineCut = lines.length > maxLines
  let output = lineCut ? lines.slice(0, maxLines).join('\n') : trimmed
  let charCut = false
  if (output.length > maxChars) {
    charCut = true
    output = `${output.slice(0, Math.max(0, maxChars - 1))}…`
  }
  return { text: output, truncated: lineCut || charCut, totalLines: lines.length }
}
