import assert from 'node:assert/strict'
import test from 'node:test'

import { detectIntent, reminderText, userMessageText } from '../src/intent.js'

test('remember intent is recognized in Chinese and English', () => {
  for (const text of ['请记住构建用 pnpm', '帮我记一下端口是 5550', '牢记这条约定', '别忘了我用的是 Windows', 'remember that tests use node:test']) {
    assert.equal(detectIntent(text)?.kind, 'remember', text)
  }
})

test('forget intent is recognized in Chinese and English', () => {
  for (const text of ['忘掉关于端口的记忆', '这条可以忘记了', '不要再记这个了', 'forget the port memory']) {
    assert.equal(detectIntent(text)?.kind, 'forget', text)
  }
})

test('ordinary prose does not trigger a reminder', () => {
  for (const text of ['记得上次说过这个吗', '你还记得吗', '这次不用改', '', '   ']) {
    assert.equal(detectIntent(text), null, text)
  }
})

test('forget wins when the user says both', () => {
  assert.equal(detectIntent('记住，但是忘掉之前那条')?.kind, 'forget')
})

test('userMessageText joins text blocks only', () => {
  const message = {
    content: [
      { type: 'text', text: '第一行' },
      { type: 'image', source: {} },
      { type: 'text', text: '第二行' },
    ],
  }
  assert.equal(userMessageText(message), '第一行\n第二行')
  assert.equal(userMessageText({ content: 'plain' }), 'plain')
  assert.equal(userMessageText({}), '')
})

test('reminderText points at the right tools', () => {
  assert.match(reminderText({ kind: 'remember', term: '记住' }, { hasIndex: true }), /claude_memory_search/)
  assert.match(reminderText({ kind: 'remember', term: '记住' }, { hasIndex: true }), /action=update/)
  assert.match(reminderText({ kind: 'remember', term: '记住' }, { hasIndex: false }), /action=create/)
  assert.match(reminderText({ kind: 'forget', term: '忘掉' }, { hasIndex: true }), /claude_memory_forget/)
  assert.match(reminderText({ kind: 'forget', term: '忘掉' }, { hasIndex: true }), /expected_revision/)
})
