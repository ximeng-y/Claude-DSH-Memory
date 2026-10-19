import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../src/config.js'

test('defaults resolve to absolute directories', () => {
  const { config, problems, warnings } = resolveConfig({}, { env: { DSH_HOME: 'C:/Users/x/.dsh' } })
  assert.deepEqual(problems, [])
  assert.deepEqual(warnings, [])
  assert.equal(config.stateRoot, 'C:\\Users\\x\\.dsh\\claude-memory')
  assert.equal(config.autoExtract, true)
  assert.equal(config.guardEnabled, true)
  assert.equal(config.createMissing, true)
  assert.equal(config.intentReminder, 'pre-step')
  assert.equal(config.extract.maxOperations, 10)
})

test('unknown keys warn but do not fail', () => {
  const { warnings, problems } = resolveConfig({ nope: 1 })
  assert.equal(problems.length, 0)
  assert.match(warnings[0], /未知配置字段/)
})

test('bad values become problems and fall back', () => {
  const { config, problems } = resolveConfig({
    indexMaxLines: 'many',
    intentReminder: 'sometimes',
    projectMemoryDirs: { relative: 'C:/x' },
    stateRoot: 'not-absolute',
  })
  assert.equal(problems.length, 4)
  assert.equal(config.indexMaxLines, 200)
  assert.equal(config.intentReminder, 'pre-step')
  assert.deepEqual(config.projectMemoryDirs, [])
  assert.match(config.stateRoot, /claude-memory$/)
})

test('mapping is sorted longest-prefix-first and absolutized', () => {
  const { config } = resolveConfig({
    projectMemoryDirs: {
      'C:/work/app': 'D:/mem/app',
      'C:/work/app/sub': 'D:/mem/sub',
    },
  })
  assert.equal(config.projectMemoryDirs.length, 2)
  assert.equal(config.projectMemoryDirs[0][1], 'D:\\mem\\sub')
})

test('CLAUDE_CONFIG_DIR is honored when claudeConfigDir is unset', () => {
  const { config } = resolveConfig({}, { env: { CLAUDE_CONFIG_DIR: 'D:/claude', DSH_HOME: 'E:/dsh' } })
  assert.equal(config.claudeConfigDir, 'D:\\claude')
  assert.equal(config.stateRoot, 'E:\\dsh\\claude-memory')
})

test('extract route overrides are validated', () => {
  const { config, problems } = resolveConfig({ extract: { provider: 'deepseek', model: 'deepseek-chat', maxOperations: 50 } })
  assert.equal(config.extract.provider, 'deepseek')
  assert.equal(config.extract.model, 'deepseek-chat')
  assert.equal(config.extract.maxOperations, 10)
  assert.equal(problems.length, 1)
})
