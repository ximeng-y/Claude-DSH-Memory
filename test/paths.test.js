import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { CODES } from '../src/errors.js'
import { canSlug, createMemoryRoot, inspectMemoryRoot, resolveMemoryRoot, slugForPath } from '../src/paths.js'
import { cleanup, tempDir } from './helpers.js'

/** @param {any} value */
const codeOf = (value) => /** @type {any} */ (value).code

test('slug algorithm v1 matches Claude Code', () => {
  assert.equal(slugForPath('D:\\work\\demo-app'), 'D--work-demo-app')
  assert.equal(slugForPath('D:/work/Claude-DSH-Memory'), 'D--work-Claude-DSH-Memory')
  assert.equal(canSlug('D:\\work\\demo-app'), true)
  assert.equal(canSlug('E:\\others\\中文项目'), false)
})

test('explicit mapping wins and is marked confirmed', async () => {
  const base = await tempDir('paths-mapping')
  try {
    const memory = path.join(base, 'mem')
    const config = { claudeConfigDir: path.join(base, 'claude'), projectMemoryDirs: [[path.join(base, 'project'), memory]] }
    const resolved = await resolveMemoryRoot({ cwd: path.join(base, 'project'), config, env: {} })
    assert.equal(resolved.dir, memory)
    assert.equal(resolved.source, 'mapping')
    assert.equal(resolved.confirmed, true)
  } finally {
    await cleanup(base)
  }
})

test('slug fallback is unconfirmed and warns', async () => {
  const base = await tempDir('paths-slug')
  try {
    const config = { claudeConfigDir: path.join(base, 'claude'), projectMemoryDirs: [] }
    const cwd = path.join(base, 'proj')
    await fs.mkdir(cwd, { recursive: true })
    const resolved = await resolveMemoryRoot({ cwd, config, env: {} })
    assert.equal(resolved.source, 'slug')
    assert.equal(resolved.confirmed, false)
    assert.match(resolved.dir, /projects/)
    assert.match(resolved.warnings[0], /尚未在 Claude Code 中核对/)
  } finally {
    await cleanup(base)
  }
})

test('project settings autoMemoryDirectory requires an explicit mapping', async () => {
  const base = await tempDir('paths-settings')
  try {
    const cwd = path.join(base, 'proj')
    await fs.mkdir(path.join(cwd, '.claude'), { recursive: true })
    await fs.writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: 'D:/mem' }))
    const config = { claudeConfigDir: path.join(base, 'claude'), projectMemoryDirs: [] }
    await assert.rejects(
      resolveMemoryRoot({ cwd, config, env: {} }),
      (error) => codeOf(error) === CODES.DIR_NEEDS_MAPPING,
    )
  } finally {
    await cleanup(base)
  }
})

test('user settings autoMemoryDirectory is used', async () => {
  const base = await tempDir('paths-user')
  try {
    const claude = path.join(base, 'claude')
    await fs.mkdir(claude, { recursive: true })
    await fs.writeFile(path.join(claude, 'settings.json'), JSON.stringify({ autoMemoryDirectory: path.join(base, 'user-mem') }))
    const cwd = path.join(base, 'proj')
    await fs.mkdir(cwd, { recursive: true })
    const resolved = await resolveMemoryRoot({ cwd, config: { claudeConfigDir: claude, projectMemoryDirs: [] }, env: {} })
    assert.equal(resolved.source, 'user-settings')
    assert.equal(resolved.dir, path.join(base, 'user-mem'))
  } finally {
    await cleanup(base)
  }
})

test('CLAUDE_CODE_PROJECT_DIR_NAME overrides the slug', async () => {
  const base = await tempDir('paths-env')
  try {
    const config = { claudeConfigDir: path.join(base, 'claude'), projectMemoryDirs: [] }
    const cwd = path.join(base, 'proj')
    await fs.mkdir(cwd, { recursive: true })
    const resolved = await resolveMemoryRoot({ cwd, config, env: { CLAUDE_CODE_PROJECT_DIR_NAME: 'custom-dir' } })
    assert.equal(resolved.source, 'env-dir-name')
    assert.equal(resolved.dir, path.join(base, 'claude', 'projects', 'custom-dir', 'memory'))
  } finally {
    await cleanup(base)
  }
})

test('create only happens when asked, and is idempotent', async () => {
  const base = await tempDir('paths-create')
  try {
    const dir = path.join(base, 'memory')
    const before = await inspectMemoryRoot(dir)
    assert.equal(before.exists, false)
    const created = await createMemoryRoot(dir)
    assert.equal(created.created, true)
    assert.equal((await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8')), '')
    const again = await createMemoryRoot(dir)
    assert.equal(again.created, false)
  } finally {
    await cleanup(base)
  }
})

test('a symlinked memory directory is refused', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('junction creation is Windows-specific in this test')
    return
  }
  const base = await tempDir('paths-link')
  try {
    const real = path.join(base, 'real')
    await fs.mkdir(real, { recursive: true })
    const link = path.join(base, 'link')
    await fs.symlink(real, link, 'junction')
    const info = await inspectMemoryRoot(link)
    assert.equal(info.isLink, true)
    await assert.rejects(createMemoryRoot(link), (error) => codeOf(error) === CODES.DIR_UNCONFIRMED)
  } finally {
    await cleanup(base)
  }
})
