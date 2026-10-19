import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { CODES } from '../src/errors.js'
import {
  buildPrompt,
  extractJson,
  publishOperations,
  snapshotDigest,
  snapshotId,
  validateOperations,
} from '../src/extract.js'
import { cleanup, makeStore } from './helpers.js'

/** @param {any} value */
const codeOf = (value) => /** @type {any} */ (value).code

const manifest = [{ filename: 'build.md', name: 'build', description: 'd', type: 'project' }]

test('extractJson accepts fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n{"operations":[]}\n```'), { operations: [] })
  assert.deepEqual(extractJson('好的：\n{"operations":[]}\n以上。'), { operations: [] })
  assert.throws(() => extractJson('no json here'), (error) => codeOf(error) === CODES.EXTRACT_PARSE)
  assert.throws(() => extractJson('{broken'), (error) => codeOf(error) === CODES.EXTRACT_PARSE)
})

test('validation enforces the create contract', () => {
  const good = validateOperations(
    {
      operations: [
        { action: 'create', name: 'new-thing', description: '说明', type: 'project', body: '正文' },
      ],
    },
    { manifest },
  )
  assert.equal(good.length, 1)
  assert.equal(good[0].action, 'create')

  const cases = [
    [{ operations: [{ action: 'delete', filename: 'build.md' }] }, /禁止 delete/],
    [{ operations: [{ action: 'create', name: 'x', type: 'project', body: 'b' }] }, /description/],
    [{ operations: [{ action: 'create', name: 'x', description: 'd', type: 'bogus', body: 'b' }] }, /type/],
    [{ operations: [{ action: 'create', name: 'x', description: 'd', type: 'user', body: '' }] }, /body/],
    [{ operations: [{ action: 'update', filename: 'missing.md', body: 'b' }] }, /不存在/],
    [{ operations: [{ action: 'update', name: 'nope', body: 'b' }] }, /无法唯一匹配/],
    [{ operations: Array.from({ length: 11 }, () => ({ action: 'create', name: 'x', description: 'd', type: 'user', body: 'b' })) }, /超过上限/],
    [{ nope: true }, /operations/],
  ]
  for (const [parsed, pattern] of cases) {
    assert.throws(
      () => validateOperations(parsed, { manifest }),
      (error) => codeOf(error) === CODES.EXTRACT_PARSE && pattern.test(/** @type {Error} */ (error).message),
    )
  }
})

test('publish applies creates and reports stale on external change', async () => {
  const { store, state, memoryRoot, base } = await makeStore()
  try {
    const snapshot = {
      id: snapshotId('session-abc', 1),
      sessionId: 'session-abc',
      turn: 1,
      cwd: memoryRoot,
      memoryDir: memoryRoot,
      capturedAt: new Date().toISOString(),
      userText: 'u',
      assistantText: 'a',
      manifest: [],
      dirFingerprint: await store.dirFingerprint(),
    }
    const operations = validateOperations(
      { operations: [{ action: 'create', name: 'learned', description: '学到的东西', type: 'project', body: '正文' }] },
      { manifest: [] },
    )
    const ok = await publishOperations({ store, state, snapshot, operations })
    assert.equal(ok.status, 'ok')
    assert.deepEqual(ok.applied, ['learned.md'])

    // Second batch against the same snapshot must be refused: the directory moved.
    const stale = await publishOperations({ store, state, snapshot, operations })
    assert.equal(stale.status, 'stale')
    assert.deepEqual(stale.applied, [])

    const reviewFiles = await fs.readdir(state.reviewDir)
    assert.equal(reviewFiles.length, 1)
  } finally {
    await cleanup(base)
  }
})

test('publish stops at the first failure and keeps a review file', async () => {
  const { store, state, memoryRoot, base } = await makeStore()
  try {
    const snapshot = {
      id: 'snapshot-1',
      sessionId: 's',
      turn: 1,
      cwd: memoryRoot,
      memoryDir: memoryRoot,
      capturedAt: new Date().toISOString(),
      userText: '',
      assistantText: '',
      manifest: [],
      dirFingerprint: await store.dirFingerprint(),
    }
    const operations = [
      { action: 'create', filename: null, name: 'a', description: 'd', type: 'user', title: '', body: 'b', reason: '' },
      { action: 'update', filename: 'ghost.md', name: '', description: '', type: '', title: '', body: 'b', reason: '' },
    ]
    const result = await publishOperations({ store, state, snapshot, operations })
    assert.equal(result.status, 'partial')
    assert.deepEqual(result.applied, ['a.md'])
    assert.equal(result.error?.code, CODES.FILE_NOT_FOUND)
  } finally {
    await cleanup(base)
  }
})

test('snapshot digest is stable and prompt includes both texts', () => {
  const snapshot = {
    id: 'x',
    sessionId: 's',
    turn: 1,
    cwd: 'c',
    memoryDir: 'm',
    capturedAt: 't',
    userText: '用户说的话',
    assistantText: '助手说的话',
    manifest: [],
    dirFingerprint: { 'MEMORY.md': 'abc' },
  }
  assert.equal(snapshotDigest(snapshot), snapshotDigest({ ...snapshot }))
  assert.notEqual(snapshotDigest(snapshot), snapshotDigest({ ...snapshot, assistantText: '别的' }))
  const prompt = buildPrompt(snapshot)
  assert.match(prompt, /用户说的话/)
  assert.match(prompt, /助手说的话/)
  assert.match(prompt, /禁止删除/)
})

test('snapshot ids are filesystem safe', () => {
  assert.equal(snapshotId('session:1/2', 3), 'cmx-session-1-2-3')
})
