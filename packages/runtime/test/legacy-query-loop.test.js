import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop, ModelProtocolError } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { query } from '../src/legacy-query/query.js';

function registry() {
  const tools = new ToolRegistry();
  tools.register({
    name: 'Read', description: 'Read a test value.',
    isConcurrencySafe: () => true,
    inputSchema: {
      type: 'object', properties: { key: { type: 'string' } },
      required: ['key'], additionalProperties: false,
    },
    execute: async ({ key }) => 'value:' + key,
  });
  return tools;
}

test('ported 2.1.88 query follows actual tool_use despite misleading end_turn', async () => {
  let requests = 0;
  let executions = 0;
  const tools = registry();
  const originalRead = tools.get('Read').execute;
  const before = [];
  const model = { async *stream({ messages }) {
    requests++;
    if (requests === 1) {
      yield { type: 'text_delta', text: 'reading ' };
      yield { type: 'tool_use', id: 'old-query-1', name: 'Read', input: { key: 'file' } };
      yield { type: 'message_end', stopReason: 'end_turn' };
    } else {
      const last = messages.at(-1);
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].tool_use_id, 'old-query-1');
      assert.equal(last.content[0].content, 'value:file');
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
  const loop = new AgentLoop({
    model, tools,
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  loop.on('turnStarted', event => before.push(event.turn));
  const result = await loop.run({ input: 'Read the file' });
  assert.deepEqual(before, [1, 2]);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.turns, 2);
  assert.equal(result.messages[1].stop_reason, 'end_turn');
  assert.equal(result.messages[2].content[0].content, 'value:file');
  assert.equal(result.finalMessage.content[0].text, 'done');
});

test('ported 2.1.88 query does not invent tool execution for stop_reason tool_use alone', async () => {
  let calls = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      calls++;
      yield { type: 'text_delta', text: 'no tools actually requested' };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } },
  });
  const result = await loop.run({ input: 'hello' });
  assert.equal(calls, 1);
  assert.equal(result.turns, 1);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.finalMessage.stop_reason, 'tool_use');
  assert.equal(result.messages.length, 2);
});

test('ported query persists complete multi-tool results and obeys maximum-turn boundary', async () => {
  const tools = registry();
  let executions = 0;
  const model = { async *stream() {
    yield { type: 'tool_use', id: 'a', name: 'Read', input: { key: 'A' } };
    yield { type: 'tool_use', id: 'b', name: 'Read', input: { key: 'B' } };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const loop = new AgentLoop({
    model, tools, maxTurns: 1,
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  loop.on('toolCallFinished', () => { executions++; });
  const result = await loop.run({ input: 'read two things' });
  assert.equal(result.stopReason, 'max_turns');
  assert.equal(result.turns, 1);
  assert.equal(executions, 2);
  assert.deepEqual(result.messages.at(-1).content.map(b => b.tool_use_id).sort(), ['a', 'b']);
  assert.deepEqual(result.messages.at(-1).content.map(b => b.content).sort(), ['value:A', 'value:B']);
});

test('ported query preserves strict malformed message protections', async () => {
  const loop = new AgentLoop({
    model: { async *stream() {
      yield { type: 'tool_use', id: 'invalid', name: 'Read', input: { key: 'a' } };
      yield { type: 'message_end', stopReason: 'end_turn' };
      yield { type: 'text_delta', text: 'not allowed' };
    } },
    tools: registry(),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  await assert.rejects(loop.run({ input: 'invalid stream' }), ModelProtocolError);
  assert.equal(loop.active, false);
});

test('ported query keeps event lifecycle and cancellation semantics on streaming failure', async () => {
  let errored = 0;
  const error = new Error('model stream dropped');
  const loop = new AgentLoop({
    model: { async *stream() {
      yield { type: 'text_delta', text: 'partial response' };
      throw error;
    } },
  });
  const deltas = [];
  loop.on('textDelta', e => deltas.push(e.text));
  loop.on('modelError', ({ error: e }) => {
    assert.equal(e, error);
    errored++;
  });
  await assert.rejects(loop.run({ input: 'drop stream' }), error);
  assert.deepEqual(deltas, ['partial response']);
  assert.equal(errored, 1);
  assert.equal(loop.active, false);
});

test('ported query is the same model loop exercised by AgentLoop, not an unused reference copy', async () => {
  const emitted = [];
  const result = await query({
    messages: [], input: 'hello',
    maxTurns: 2,
    model: { async *stream() {
      yield { type: 'text_delta', text: 'direct query' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    } },
    tools: registry(),
    executeTool: async () => { throw new Error('no tool expected'); },
    emit: (type, value) => emitted.push([type, value]),
  });
  assert.equal(result.finalMessage.content[0].text, 'direct query');
  assert.deepEqual(emitted.map(x => x[0]), [
    'runStarted', 'turnStarted', 'textDelta', 'assistantMessage',
    'turnFinished', 'finished',
  ]);
});

test('ported Query preserves unknown-tool completion events after extracting the model loop', async () => {
  let round = 0;
  const model = { async *stream() {
    if (round++ === 0) {
      yield { type: 'tool_use', id: 'missing-21', name: 'AbsentTool', input: {} };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'handled' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
  const loop = new AgentLoop({ model, tools: registry() });
  const finished = [];
  loop.on('toolCallFinished', e => finished.push(e));
  const result = await loop.run({ input: 'unknown query tool' });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.messages[2].content[0].tool_use_id, 'missing-21');
  assert.equal(result.messages[2].content[0].is_error, true);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].toolName, 'AbsentTool');
  assert.equal(finished[0].isError, true);
});
