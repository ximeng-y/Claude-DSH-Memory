import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatIndexForContext,
  indexTargets,
  parsePointer,
  pointerLine,
  removeIndexText,
  slugifyFilename,
  updateIndexText,
  validateFilename,
} from '../src/indexing.js'

import { CODES } from '../src/errors.js'

test('parses both separators Claude produces', () => {
  assert.deepEqual(parsePointer('- [标题](a.md) — 描述文字'), {
    filename: 'a.md',
    title: '标题',
    description: '描述文字',
    line: '- [标题](a.md) — 描述文字',
  })
  assert.equal(parsePointer('- [a](a.md) - desc')?.description, 'desc')
  assert.equal(parsePointer('# heading'), null)
  assert.equal(parsePointer('- plain bullet'), null)
})

test('pointer line escapes brackets and newlines', () => {
  const line = pointerLine('a[b]c', 'x.md', 'first\nsecond')
  assert.equal(line, '- [a（b）c](x.md) — first second')
})

test('update inserts, then replaces in place', () => {
  const first = updateIndexText('', { filename: 'a.md', title: 'A', description: 'd1' })
  assert.equal(first, '- [A](a.md) — d1\n')
  const second = updateIndexText(first, { filename: 'b.md', title: 'B', description: 'd2' })
  assert.equal(second, '- [A](a.md) — d1\n- [B](b.md) — d2\n')
  const third = updateIndexText(second, { filename: 'a.md', title: 'A2', description: 'd3' })
  assert.equal(third, '- [A2](a.md) — d3\n- [B](b.md) — d2\n')
})

test('update keeps hand-written lines and CRLF', () => {
  const text = '# Memory Index\r\n\r\n- [A](a.md) — d1\r\nnotes here\r\n'
  const next = updateIndexText(text, { filename: 'a.md', title: 'A2', description: 'd2' })
  assert.ok(next.includes('notes here'))
  assert.ok(next.includes('\r\n'))
  assert.ok(next.startsWith('# Memory Index\r\n'))
})

test('remove drops only the matching pointer', () => {
  const text = '- [A](a.md) — d1\n- [B](b.md) — d2\n'
  assert.equal(removeIndexText(text, { filename: 'a.md' }), '- [B](b.md) — d2\n')
  assert.equal(removeIndexText('- [A](a.md) — d1\n', { filename: 'a.md' }), '')
})

test('budget truncates on lines and characters', () => {
  const text = Array.from({ length: 5 }, (_, index) => `- [n${index}](f${index}.md) — d`).join('\n')
  const byLines = formatIndexForContext(text, { maxLines: 2, maxChars: 10000 })
  assert.equal(byLines.truncated, true)
  assert.equal(byLines.text.split('\n')[0], '- [n0](f0.md) — d')
  assert.match(byLines.text, /超过注入预算|超出注入预算/)

  const byChars = formatIndexForContext(text, { maxLines: 100, maxChars: 10 })
  assert.equal(byChars.truncated, true)
  assert.ok(byChars.text.length < text.length + 100)
})

test('index targets are normalized to forward slashes', () => {
  const targets = indexTargets('- [A](a.md) — d\n- [B](b.md) — d\n')
  assert.deepEqual([...targets].sort(), ['a.md', 'b.md'])
})

test('filename validation rejects escapes', () => {
  assert.equal(validateFilename(' ok-name.md '), 'ok-name.md')
  const bad = ['', 'a.txt', 'MEMORY.md', '../a.md', 'sub/a.md', '.hidden.md', 'a:b.md', 'a[b].md']
  for (const value of bad) {
    assert.throws(
      () => validateFilename(value),
      (error) => /** @type {any} */ (error).code === CODES.INVALID_FILENAME,
      `expected rejection for ${JSON.stringify(value)}`,
    )
  }
})

test('slugify keeps ascii names and hashes non-ascii ones', () => {
  assert.equal(slugifyFilename('Build Commands'), 'build-commands.md')
  assert.match(slugifyFilename('构建命令'), /^memory-[0-9a-f]{8}\.md$/)
  assert.match(slugifyFilename('构建 命令'), /^[a-z0-9-]*-[0-9a-f]{8}\.md$/)
})
