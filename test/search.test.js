import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { buildSnippet, scoreEntry, searchMemory, tokenize } from '../src/search.js'
import { cleanup, makeStore } from './helpers.js'

test('tokenize splits on unicode whitespace and dedupes', () => {
  assert.deepEqual(tokenize('  构建\u3000命令  构建 '), ['构建', '命令'])
  assert.deepEqual(tokenize(''), [])
})

test('weights name over description over body', () => {
  const terms = ['build']
  assert.equal(scoreEntry({ name: 'build', description: '', body: '' }, terms).score, 6)
  assert.equal(scoreEntry({ name: 'x', description: 'build', body: '' }, terms).score, 3)
  assert.equal(scoreEntry({ name: 'x', description: 'y', body: 'build' }, terms).score, 1)
  assert.equal(scoreEntry({ name: 'x', description: 'y', body: 'build build' }, terms).score, 1)
})

test('any term is enough and all terms accumulate', () => {
  const entry = { name: 'build-commands', description: '构建', body: 'npm run build' }
  assert.equal(scoreEntry(entry, ['build', '构建']).score, 6 + 1 + 3)
  assert.equal(scoreEntry(entry, ['build', 'missing']).score, 7)
})

test('snippet uses the first line containing the matched term', () => {
  const body = 'first line\nnpm run build\nnpm test'
  assert.equal(buildSnippet(body, ['build']), 'npm run build')
  assert.equal(buildSnippet(body, ['nomatch']), 'first line')
})

test('search filters by type and ranks', async () => {
  const { store, base } = await makeStore()
  try {
    await store.write({ action: 'create', name: 'build-commands', description: '构建命令', type: 'project', body: 'npm run build' })
    await store.write({ action: 'create', name: 'user-pref', description: '用户偏好 build', type: 'user', body: '喜欢 build' })

    const all = await searchMemory(store, { query: 'build' })
    assert.equal(all.total, 2)
    assert.equal(all.results[0].name, 'build-commands')

    const onlyUser = await searchMemory(store, { query: 'build', types: ['user'] })
    assert.equal(onlyUser.total, 1)
    assert.equal(onlyUser.results[0].name, 'user-pref')

    const none = await searchMemory(store, { query: 'nothing-here' })
    assert.equal(none.total, 0)
  } finally {
    await cleanup(base)
  }
})

test('empty query is rejected', async () => {
  const { store, base } = await makeStore()
  try {
    await assert.rejects(searchMemory(store, { query: '   ' }), (error) => /** @type {any} */ (error).code === 'CM_QUERY_EMPTY')
  } finally {
    await cleanup(base)
  }
})

test('search reads files written outside the store', async () => {
  const { store, memoryRoot, base } = await makeStore()
  try {
    await fs.writeFile(
      path.join(memoryRoot, 'external.md'),
      '---\nname: external\ndescription: 外部写入\ntype: reference\n---\n\n这是 Claude 自己写的记忆。\n',
    )
    const result = await searchMemory(store, { query: 'Claude' })
    assert.equal(result.total, 1)
    assert.equal(result.results[0].filename, 'external.md')
    assert.match(result.results[0].snippet, /Claude/)
  } finally {
    await cleanup(base)
  }
})
