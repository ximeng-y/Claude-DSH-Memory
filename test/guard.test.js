import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWriteGuard, collectCommands, collectPaths, commandMentions } from '../src/guard.js'
import { isPathInsideRoot } from '../src/guard.js'

const ROOT = 'C:\\Users\\x\\.claude\\projects\\P--proj\\memory'

/**
 * @param {{ enabled?: boolean, cwd?: string }} [options]
 */
function makeGuard(options = {}) {
  /** @type {Array<{ toolName: string, target: string | null }>} */
  const denied = []
  const guard = buildWriteGuard({
    enabled: () => options.enabled ?? true,
    cwdFor: () => options.cwd ?? 'C:\\proj',
    isProtectedPath: (absolute) => isPathInsideRoot(ROOT, absolute),
    protectedPaths: () => [ROOT],
    onDeny: (details) => denied.push(details),
    message: () => 'DENIED',
  })
  return { guard, denied }
}

test('collects path-shaped arguments at any depth', () => {
  const paths = collectPaths({
    file_path: 'C:\\a.md',
    edits: [{ path: 'b.md' }, { old_string: 'x' }],
    nested: { target_file: 'c.md' },
  })
  assert.deepEqual(paths.sort(), ['C:\\a.md', 'b.md', 'c.md'])
  assert.deepEqual(collectPaths({ query: 'text' }), [])
})

test('collects shell commands only for shell tools', () => {
  assert.deepEqual(collectCommands('pwsh', { command: 'echo hi' }), ['echo hi'])
  assert.deepEqual(collectCommands('terminal_send', { text: 'ls' }), ['ls'])
  assert.deepEqual(collectCommands('write', { command: 'echo hi' }), [])
})

test('denies absolute writes inside the memory directory', () => {
  const { guard, denied } = makeGuard()
  const reason = guard({ name: 'write', arguments: { file_path: `${ROOT}\\a.md` } })
  assert.equal(reason, 'DENIED')
  assert.equal(denied.length, 1)
  assert.equal(denied[0].toolName, 'write')
})

test('denies relative paths resolved against the session cwd', () => {
  const { guard } = makeGuard({ cwd: 'C:\\Users\\x\\.claude\\projects\\P--proj' })
  assert.equal(guard({ name: 'edit', arguments: { file_path: 'memory/a.md' } }), 'DENIED')
})

test('allows writes outside the memory directory', () => {
  const { guard, denied } = makeGuard()
  assert.equal(guard({ name: 'write', arguments: { file_path: 'C:\\proj\\src\\a.js' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { file_path: `${ROOT}\\a.md` } }), undefined)
  assert.equal(denied.length, 0)
})

test('advisory denial for shell commands mentioning the directory', () => {
  const { guard } = makeGuard()
  const reason = guard({ name: 'pwsh', arguments: { command: `Set-Content '${ROOT}\\a.md' x` } })
  assert.equal(reason, 'DENIED')
  assert.equal(guard({ name: 'pwsh', arguments: { command: 'Get-ChildItem' } }), undefined)
})

test('disabled guard never denies', () => {
  const { guard } = makeGuard({ enabled: false })
  assert.equal(guard({ name: 'write', arguments: { file_path: `${ROOT}\\a.md` } }), undefined)
})

test('command matching normalizes separators and quotes', () => {
  assert.ok(commandMentions('cat "C:/Users/x/.claude/projects/P--proj/memory/a.md"', [ROOT]) !== null)
  assert.equal(commandMentions('echo hello', [ROOT]), null)
})

test('path containment is case-insensitive on Windows', () => {
  assert.equal(isPathInsideRoot(ROOT, `${ROOT}\\X.MD`.toLowerCase()), process.platform !== 'linux')
})
