import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

function registry(counter) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'Read', description: 'Read fixture',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    isConcurrencySafe: () => true,
    execute: async ({ key }) => { counter.calls++; return 'read:' + key; },
  });
  return tools;
}

test('complete signed thinking/tool_result turn survives failure of next model stream', async () => {
  const counter = { calls: 0 }, error = new Error('upstream connection lost');
  let turn = 0;
  const snapshots = [];
  const messages = [{ role: 'user', content: 'prior prompt' }];
  const model = { async *stream({ messages: input }) {
    turn++;
    if (turn === 1) {
      yield { type: 'thinking', thinking: 'do not show', signature: 'signed-opaque' };
      yield { type: 'tool_use', id: 'read-1', name: 'Read', input: { key: 'math.js' } };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } else if (turn === 2) {
      assert.equal(input.at(-1).content[0].content, 'read:math.js');
      yield { type: 'text_delta', text: 'uncommitted partial answer' };
      throw error;
    } else {
      assert.equal(input.length, 5);
      assert.deepEqual(input.map(m => m.role),
        ['user', 'user', 'assistant', 'user', 'user']);
      assert.equal(input[2].content[0].signature, 'signed-opaque');
      assert.equal(input[3].content[0].tool_use_id, 'read-1');
      yield { type: 'text_delta', text: 'Continuation knows tool already ran.' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
  const loop = new AgentLoop({
    model, tools: registry(counter),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  loop.on('turnFinished', payload => {
    if (payload.committedMessages) snapshots.push(payload.committedMessages);
  });
  await assert.rejects(loop.run({ messages, input: 'read file' }), error);
  assert.equal(counter.calls, 1);
  assert.equal(snapshots.length, 1, 'only fully completed tool rounds may checkpoint');
  assert.deepEqual(snapshots[0].map(m => m.role),
    ['user', 'user', 'assistant', 'user']);
  assert.deepEqual(snapshots[0][2].content, [
    { type: 'thinking', thinking: 'do not show', signature: 'signed-opaque' },
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { key: 'math.js' } },
  ]);
  assert.equal(snapshots[0][3].content[0].content, 'read:math.js');
  assert.deepEqual(messages, [{ role: 'user', content: 'prior prompt' }]);
  const resumed = await loop.run({ messages: snapshots[0], input: 'continue' });
  assert.equal(resumed.finalMessage.content[0].text, 'Continuation knows tool already ran.');
  assert.equal(counter.calls, 1, 'resume must not replay the successful tool');
});

test('truncated model response before message_end never emits recoverable checkpoint', async () => {
  const snapshots = [], counter = { calls: 0 };
  const loop = new AgentLoop({
    model: { async *stream() {
      yield { type: 'tool_use', id: 'partial', name: 'Read', input: { key: 'math.js' } };
      throw new Error('truncated SSE');
    } },
    tools: registry(counter),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  loop.on('turnFinished', payload => {
    if (payload.committedMessages) snapshots.push(payload.committedMessages);
  });
  await assert.rejects(loop.run({ input: 'read' }), /truncated SSE/);
  assert.equal(snapshots.length, 0);
  assert.equal(counter.calls, 0, 'failed stream must not create tool effects');
});
