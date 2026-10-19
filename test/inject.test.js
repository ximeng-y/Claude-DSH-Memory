import assert from 'node:assert/strict'
import test from 'node:test'

import { buildBaseline, buildDiagnosis, buildInjectionMessage, SOURCE_KIND } from '../src/inject.js'

test('baseline carries the index and the conventions', () => {
  const text = buildBaseline({
    memoryDir: 'C:\\Users\\x\\.claude\\projects\\P--proj\\memory',
    indexText: '- [a](a.md) — 说明',
    maxChars: 16000,
  })
  assert.match(text, /# Claude-DSH-Memory/)
  assert.match(text, /## 维护约定/)
  assert.match(text, /## 当前项目 MEMORY.md/)
  assert.match(text, /- \[a\]\(a\.md\) — 说明/)
  assert.match(text, /claude_memory_write/)
  assert.match(text, /禁止直接用文件工具修改/)
})

test('unconfirmed directories and extraction are announced', () => {
  const text = buildBaseline({
    memoryDir: 'D:\\mem',
    unconfirmed: true,
    extractionNote: true,
    indexText: '',
    maxChars: 16000,
  })
  assert.match(text, /尚未在 Claude Code 中核对/)
  assert.match(text, /后台记忆提取/)
  assert.match(text, /当前项目还没有记忆索引/)
})

test('an undetermined directory still produces a diagnosis', () => {
  const text = buildBaseline({ memoryDir: null, maxChars: 16000 })
  assert.match(text, /无法确定本项目的记忆目录/)
  assert.match(text, /projectMemoryDirs/)
  assert.match(buildDiagnosis('CM_DIR_UNDETERMINED：x'), /CM_DIR_UNDETERMINED/)
})

test('budget trims the index before dropping conventions', () => {
  const index = Array.from({ length: 400 }, (_, i) => `- [n${i}](f${i}.md) — ${'d'.repeat(60)}`).join('\n')
  const text = buildBaseline({ memoryDir: 'D:\\mem', indexText: index, maxChars: 4000 })
  assert.ok(text.length <= 4000, `length ${text.length}`)
  assert.match(text, /检索完整内容|按预算截断|超出注入预算/)
  assert.match(text, /## 维护约定/)
})

test('injection message is tagged for resume dedupe', () => {
  const message = buildInjectionMessage('hello', 'id-1')
  assert.equal(message.role, 'user')
  assert.equal(message.id, 'id-1')
  assert.equal(message.source.kind, SOURCE_KIND)
  assert.equal(message.content[0].type, 'text')
  assert.equal(message.content[0].text, 'hello')
  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source'])
})
