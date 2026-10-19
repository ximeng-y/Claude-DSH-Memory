import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { CODES } from '../src/errors.js'
import { cleanup, makeStore } from './helpers.js'

/** @param {any} value */
const codeOf = (value) => /** @type {any} */ (value).code

test('create writes the body and the pointer', async () => {
  const { store, memoryRoot, base } = await makeStore()
  try {
    const result = await store.write({
      action: 'create',
      name: 'build-commands',
      description: '本项目的构建与验证命令',
      type: 'project',
      body: 'npm run build',
    })
    assert.equal(result.action, 'create')
    assert.equal(result.filename, 'build-commands.md')
    assert.equal(result.indexUpdated, true)
    assert.match(result.revision, /^[0-9a-f]{64}$/)

    const body = await fs.readFile(path.join(memoryRoot, 'build-commands.md'), 'utf8')
    assert.match(body, /metadata:\n {2}type: "project"/)
    assert.match(body, /npm run build/)

    const index = await fs.readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8')
    assert.equal(index, '- [build-commands](build-commands.md) — 本项目的构建与验证命令\n')
  } finally {
    await cleanup(base)
  }
})

test('create refuses an existing target', async () => {
  const { store, base } = await makeStore()
  try {
    await store.write({ action: 'create', name: 'a', description: 'd', type: 'user', body: 'x' })
    await assert.rejects(
      store.write({ action: 'create', name: 'a', description: 'd', type: 'user', body: 'y' }),
      (error) => codeOf(error) === CODES.FILE_EXISTS,
    )
  } finally {
    await cleanup(base)
  }
})

test('update needs a matching revision', async () => {
  const { store, base } = await makeStore()
  try {
    await store.write({ action: 'create', name: 'a', description: 'd', type: 'user', body: 'one' })
    const read = await store.read({ filename: 'a.md' })

    await assert.rejects(
      store.write({ action: 'update', filename: 'a.md', description: 'd', type: 'user', body: 'two' }),
      (error) => codeOf(error) === CODES.REVISION_REQUIRED,
    )
    await assert.rejects(
      store.write({ action: 'update', filename: 'a.md', expectedRevision: 'deadbeef', description: 'd', type: 'user', body: 'two' }),
      (error) => codeOf(error) === CODES.REVISION_MISMATCH,
    )
    const updated = await store.write({
      action: 'update',
      filename: 'a.md',
      expectedRevision: read.revision,
      description: 'd2',
      type: 'user',
      body: 'two',
    })
    assert.equal(updated.action, 'update')
    assert.notEqual(updated.revision, read.revision)
    const again = await store.read({ filename: 'a.md' })
    assert.equal(again.body, 'two')
    assert.equal(again.description, 'd2')
    const index = await fs.readFile(path.join(store.root, 'MEMORY.md'), 'utf8')
    assert.match(index, /— d2/)
  } finally {
    await cleanup(base)
  }
})

test('update of a missing file reports FILE_NOT_FOUND', async () => {
  const { store, base } = await makeStore()
  try {
    await assert.rejects(
      store.write({ action: 'update', filename: 'nope.md', expectedRevision: 'x', description: 'd', type: 'user', body: 'x' }),
      (error) => codeOf(error) === CODES.FILE_NOT_FOUND,
    )
  } finally {
    await cleanup(base)
  }
})

test('forget moves the file into trash and drops the pointer', async () => {
  const { store, memoryRoot, base } = await makeStore()
  try {
    await store.write({ action: 'create', name: 'a', description: 'd', type: 'user', body: 'one' })
    await store.write({ action: 'create', name: 'b', description: 'd2', type: 'user', body: 'two' })
    const read = await store.read({ filename: 'a.md' })
    const result = await store.forget({ filename: 'a.md', expectedRevision: read.revision, reason: 'test' })
    assert.equal(result.indexUpdated, true)
    assert.match(result.trashedTo, /trash/)
    await assert.rejects(fs.access(path.join(memoryRoot, 'a.md')))
    const index = await fs.readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8')
    assert.doesNotMatch(index, /a\.md/)
    assert.match(index, /b\.md/)
    const trash = await fs.readFile(result.trashedTo, 'utf8')
    assert.match(trash, /one/)
  } finally {
    await cleanup(base)
  }
})

test('manifest flags orphan entries', async () => {
  const { store, memoryRoot, base } = await makeStore()
  try {
    await store.write({ action: 'create', name: 'a', description: 'd', type: 'user', body: 'one' })
    await fs.writeFile(path.join(memoryRoot, 'orphan.md'), '---\nname: orphan\ndescription: 孤儿\n---\n\nbody\n')
    const manifest = await store.manifest({ limit: 100 })
    const byName = new Map(manifest.entries.map((entry) => [entry.name, entry]))
    assert.equal(byName.get('a')?.indexed, true)
    assert.equal(byName.get('orphan')?.indexed, false)
    assert.equal(manifest.total, 2)
  } finally {
    await cleanup(base)
  }
})

test('repair index reports and then applies', async () => {
  const { store, memoryRoot, base } = await makeStore()
  try {
    await fs.writeFile(path.join(memoryRoot, 'orphan.md'), '---\nname: orphan\ndescription: 孤儿\n---\n\nbody\n')
    await fs.writeFile(path.join(memoryRoot, 'MEMORY.md'), '- [ghost](ghost.md) — 不存在的文件\n')

    const dry = await store.repairIndex({ dryRun: true })
    assert.equal(dry.applied, false)
    assert.deepEqual(dry.changes.map((change) => change.kind).sort(), ['add', 'remove'])

    const applied = await store.repairIndex({ dryRun: false })
    assert.equal(applied.applied, true)
    const index = await fs.readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8')
    assert.match(index, /orphan\.md/)
    assert.doesNotMatch(index, /ghost\.md/)
  } finally {
    await cleanup(base)
  }
})

test('createMissing=false refuses to create the directory', async () => {
  const { store, base } = await makeStore({ config: { createMissing: false } })
  try {
    await fs.rm(store.root, { recursive: true, force: true })
    await assert.rejects(
      store.write({ action: 'create', name: 'a', description: 'd', type: 'user', body: 'x' }),
      (error) => codeOf(error) === CODES.DIR_NOT_FOUND,
    )
  } finally {
    await cleanup(base)
  }
})

test('path escapes and reserved names are rejected', async () => {
  const { store, base } = await makeStore()
  try {
    for (const filename of ['../escape.md', 'MEMORY.md', 'sub/a.md']) {
      await assert.rejects(
        store.write({ action: 'create', filename, description: 'd', type: 'user', body: 'x' }),
        (error) => codeOf(error) === CODES.INVALID_FILENAME,
      )
    }
  } finally {
    await cleanup(base)
  }
})

test('ambiguous names are reported with candidates', async () => {
  const { store, memoryRoot, base } = await makeStore()
  try {
    await fs.writeFile(path.join(memoryRoot, 'one.md'), '---\nname: dup\ndescription: d\n---\n\nbody\n')
    await fs.writeFile(path.join(memoryRoot, 'two.md'), '---\nname: dup\ndescription: d\n---\n\nbody\n')
    await assert.rejects(
      store.read({ name: 'dup' }),
      (error) => codeOf(error) === CODES.AMBIGUOUS_NAME && /** @type {any} */ (error).details.candidates.length === 2,
    )
  } finally {
    await cleanup(base)
  }
})
