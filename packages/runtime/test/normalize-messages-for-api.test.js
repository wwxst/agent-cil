import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessagesForAPI } from '../src/legacy-query/normalize-messages-for-api.js';

test('same-ID assistant fragments merge across tool-result users and other assistant IDs', () => {
  const normalized = normalizeMessagesForAPI([
    {
      role: 'assistant', sourceMessageId: 'assistant-A',
      content: [{ type: 'tool_use', id: 'a-first', name: 'Grep', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a-first', content: 'first' }],
    },
    {
      role: 'assistant', sourceMessageId: 'assistant-B',
      content: [{ type: 'tool_use', id: 'b-middle', name: 'Read', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'b-middle', content: 'middle' }],
    },
    {
      role: 'assistant', sourceMessageId: 'assistant-A',
      content: [{ type: 'tool_use', id: 'a-last', name: 'Grep', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a-last', content: 'last' }],
    },
  ]);

  assert.equal(normalized.length, 4);
  assert.deepEqual(normalized[0].content.map(block => block.id), ['a-first', 'a-last']);
  assert.deepEqual(
    normalized[3].content.map(block => block.tool_use_id),
    ['b-middle', 'a-last'],
    'tool results remain in transcript order after the same-ID assistant merge',
  );
  assert.ok(normalized.every(message =>
    !Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'sourceMessageId')),
  'internal assistant IDs must not leak into provider API messages');
});

test('same-ID assistant fragments do not merge across an unrelated user message', () => {
  const normalized = normalizeMessagesForAPI([
    { role: 'assistant', sourceMessageId: 'assistant-A', content: [{ type: 'text', text: 'before' }] },
    { role: 'user', content: 'a real user turn' },
    { role: 'assistant', sourceMessageId: 'assistant-A', content: [{ type: 'text', text: 'after' }] },
  ]);
  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[0].content, [{ type: 'text', text: 'before' }]);
  assert.deepEqual(normalized[2].content, [{ type: 'text', text: 'after' }]);
});
