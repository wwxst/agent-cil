import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countUnseenAssistantTurns } from '../src/tui/useUnseenDivider.js';

test('unseen transcript count includes only assistant messages with visible text after the snapshot', () => {
  const messages = [
    { role: 'user', text: 'old prompt' },
    { role: 'assistant', text: 'old answer' },
    { role: 'user', text: 'new prompt' },
    { role: 'assistant', text: 'first unseen answer' },
    { role: 'tool', text: '', status: 'succeeded' },
    { role: 'assistant', text: 'second unseen answer' },
    { role: 'assistant', text: 'continuation of the same turn' },
    { role: 'assistant', text: '   ', streaming: true },
    { role: 'system', text: 'background notice' },
  ];

  assert.equal(countUnseenAssistantTurns(messages, 2), 2);
});

test('unseen transcript count is zero for invalid snapshots and empty assistant placeholders', () => {
  const messages = [
    { role: 'assistant', text: '   ', streaming: true },
    { role: 'tool', text: '' },
    { role: 'system', text: 'notice' },
  ];

  assert.equal(countUnseenAssistantTurns(messages, null), 0);
  assert.equal(countUnseenAssistantTurns(messages, 0), 0);
  assert.equal(countUnseenAssistantTurns(messages, 3), 0);
});
