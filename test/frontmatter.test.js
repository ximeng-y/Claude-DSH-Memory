import assert from 'node:assert/strict'
import test from 'node:test'

import { assertWritable, parseDocument, renderDocument } from '../src/frontmatter.js'
import { CODES } from '../src/errors.js'

const CLAUDE_SAMPLE = `---
name: clean-project-rule
description: 本项目为清洁项目，除本条记忆外，本项目不得生成任何项目记忆
metadata:
  type: project
---

本项目为清洁项目。

**Why:** 用户要求保持本项目记忆的纯净。

**How to apply:** 不得写入任何除本条之外的记忆条目。
`

test('parses the real Claude file shape', () => {
  const doc = parseDocument(CLAUDE_SAMPLE, 'clean-project-rule.md')
  assert.equal(doc.hasFrontmatter, true)
  assert.equal(doc.name, 'clean-project-rule')
  assert.equal(doc.type, 'project')
  assert.match(doc.body, /Why:/)
  assert.equal(doc.bom, false)
})

test('top-level type outranks metadata.type', () => {
  const text = `---\nname: a\ntype: reference\nmetadata:\n  type: project\n---\n\nbody\n`
  assert.equal(parseDocument(text).type, 'reference')
})

test('keeps unknown fields and both type locations when rewriting', () => {
  const rendered = renderDocument({
    existingText: CLAUDE_SAMPLE,
    filename: 'clean-project-rule.md',
    name: 'clean-project-rule',
    description: 'new description',
    type: 'feedback',
    body: 'new body\n',
  })
  assert.match(rendered, /metadata:\n {2}type: "feedback"/)
  assert.doesNotMatch(rendered, /^type: /m)
  assert.match(rendered, /description: "new description"/)
  assert.match(rendered, /new body/)
  assert.doesNotMatch(rendered, /modified:/)
})

test('new documents use Claude metadata.type and no modified stamp', () => {
  const rendered = renderDocument({
    existingText: null,
    filename: 'build.md',
    name: 'build',
    description: '构建命令',
    type: 'project',
    body: 'npm run build',
  })
  assert.equal(
    rendered,
    '---\nname: "build"\ndescription: "构建命令"\nmetadata:\n  type: "project"\n---\n\nnpm run build\n',
  )
})

test('unknown nested keys survive', () => {
  const text = `---\nname: x\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: abc\ncustom:\n  nested: value\n---\n\nbody\n`
  const rendered = renderDocument({
    existingText: text,
    filename: 'x.md',
    name: 'x',
    description: 'd',
    type: 'reference',
    body: 'body2',
  })
  assert.match(rendered, /node_type: memory/)
  assert.match(rendered, /originSessionId: abc/)
  assert.match(rendered, /custom:\n {2}nested: value/)
  assert.match(rendered, / {2}type: "reference"/)
})

test('preserves CRLF and BOM', () => {
  const text = '\uFEFF---\r\nname: a\r\ndescription: d\r\nmetadata:\r\n  type: user\r\n---\r\n\r\nbody\r\n'
  const rendered = renderDocument({
    existingText: text,
    filename: 'a.md',
    name: 'a',
    description: 'd2',
    type: 'user',
    body: 'body',
  })
  assert.ok(rendered.startsWith('\uFEFF---\r\n'))
  assert.ok(rendered.includes('\r\n\r\nbody\r\n'))
})

test('refuses unclosed frontmatter', () => {
  const text = '---\nname: a\n\nbody\n'
  assert.throws(() => assertWritable(text, 'a.md'), (error) => /** @type {any} */ (error).code === CODES.FRONTMATTER_INVALID)
})

test('rejects invalid type and empty body', () => {
  assert.throws(
    () => renderDocument({ existingText: '', filename: 'a.md', name: 'a', description: 'd', type: 'nope', body: 'b' }),
    (error) => /** @type {any} */ (error).code === CODES.INVALID_TYPE,
  )
  assert.throws(
    () => renderDocument({ existingText: '', filename: 'a.md', name: 'a', description: 'd', type: 'user', body: '  ' }),
    (error) => /** @type {any} */ (error).code === CODES.BODY_EMPTY,
  )
})
