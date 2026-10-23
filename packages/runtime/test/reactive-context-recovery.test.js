import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  AnthropicMessagesAdapter, ModelAdapterError,
  ModelContextLengthError, isContextLengthRejection,
} from '../src/anthropic-messages-adapter.js';
import { createAutoCompact } from '../src/legacy-compact/auto-compact.js';

const user = content => ({ role: 'user', content });
const toolCall = (id, name = 'Edit') => ({
  role: 'assistant', content: [
    { type: 'thinking', thinking: 'private planning', signature: 'signed-' + id },
    { type: 'tool_use', id, name, input: { file_path: 'math.js' } },
  ],
});
const toolResult = id => ({ role: 'user', content: [
  { type: 'tool_result', tool_use_id: id, content: 'already executed' },
] });
const history = [
  user('Fix math.js'),
  toolCall('edit-1'), toolResult('edit-1'),
  toolCall('read-2', 'Read'), toolResult('read-2'),
  toolCall('read-3', 'Read'), toolResult('read-3'),
];
function overflow() {
  return new ModelContextLengthError(
    'Messages API returned HTTP 400 (invalid_request_error): prompt is too long', { status: 400 });
}
function finalEvents() {
  return [{ type: 'text_delta', text: 'Done, without replaying tools.' },
    { type: 'message_end', stopReason: 'end_turn' }];
}
function fakeAdapter(status, body) {
  return new AnthropicMessagesAdapter({
    apiKey: 'fake-key', model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/anthropic', maxRetries: 0,
    fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify({ error: body }) }),
  });
}
async function collect(iterable) { const out = []; for await (const e of iterable) out.push(e); return out; }

test('only explicit context-window HTTP errors get typed for reactive recovery', async () => {
  for (const response of [
    [400, { type: 'invalid_request_error', message: 'prompt is too long: 1200 tokens > 1000 maximum' }],
    [400, { code: 'context_length_exceeded', message: 'Bad request' }],
    [422, { type: 'invalid_request_error', message: 'maximum context length exceeded' }],
    [413, { type: 'invalid_request_error', message: 'context window exceeded' }],
  ]) {
    assert.equal(isContextLengthRejection(response[0], JSON.stringify({ error: response[1] })), true);
    await assert.rejects(collect(fakeAdapter(...response).stream({ messages: [user('hi')] })),
      ModelContextLengthError);
  }
  for (const response of [
    [400, { type: 'invalid_request_error', message: 'invalid model name' }],
    [400, { type: 'invalid_request_error', message: 'thinking signature was modified' }],
    [400, { type: 'invalid_request_error', message: 'wrong input_schema' }],
    [401, { code: 'context_length_exceeded', message: 'unauthorized' }],
    [429, { message: 'rate limited' }],
    [413, { message: 'payload too large' }],
  ]) {
    assert.equal(isContextLengthRejection(response[0], JSON.stringify({ error: response[1] })), false);
    await assert.rejects(collect(fakeAdapter(...response).stream({ messages: [user('hi')] })),
      error => error instanceof ModelAdapterError && !(error instanceof ModelContextLengthError));
  }
});

test('typed pre-stream rejection compacts complete rounds and retries only the model request', async () => {
  let normal = 0, summary = 0, toolExecutions = 0;
  const saved = structuredClone(history);
  const model = { async *stream({ messages, purpose, tools }) {
    if (purpose === 'compact') {
      summary++;
      assert.deepEqual(tools, [], 'summary cannot request filesystem tools');
      assert.deepEqual(messages.slice(0, -1), history.slice(0, 3));
      yield { type: 'text_delta', text: 'Earlier edits and checks completed; do not repeat.' };
      yield { type: 'message_end', stopReason: 'end_turn' };
      return;
    }
    normal++;
    if (normal === 1) {
      assert.deepEqual(messages.slice(0, -1), history);
      throw overflow();
    }
    assert.equal(normal, 2);
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content, /Earlier edits and checks completed/);
    assert.deepEqual(messages.slice(1, -1), history.slice(3));
    for (const e of finalEvents()) yield e;
  } };
  const tools = new ToolRegistry();
  tools.register({ name: 'Edit', description: 'fixture', execute: async () => { toolExecutions++; } });
  const compact = createAutoCompact({ thresholdTokens: 200000 });
  const loop = new AgentLoop({
    model, tools, compactContext: context => compact.compact(context),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  let retries = 0, commits = 0;
  loop.on('contextRetry', () => retries++);
  loop.on('contextCompacted', () => commits++);
  const response = await loop.run({ messages: history, input: 'continue' });
  assert.equal(response.finalMessage.content[0].text, 'Done, without replaying tools.');
  assert.equal(retries, 1); assert.equal(commits, 1);
  assert.equal(normal, 2); assert.equal(summary, 1);
  assert.equal(toolExecutions, 0);
  assert.deepEqual(history, saved);
});

test('second overflow after successful compact does not invoke another summary or replay tools', async () => {
  let normal = 0, summary = 0;
  const model = { async *stream({ purpose }) {
    if (purpose === 'compact') {
      summary++;
      yield { type: 'text_delta', text: 'Earlier tasks were completed and verified.' };
      yield { type: 'message_end', stopReason: 'end_turn' };
      return;
    }
    normal++;
    throw overflow();
  } };
  const compact = createAutoCompact({ thresholdTokens: 200000 });
  const loop = new AgentLoop({ model, compactContext: x => compact.compact(x) });
  await assert.rejects(loop.run({ messages: history, input: 'continue' }), ModelContextLengthError);
  assert.equal(normal, 2);
  assert.equal(summary, 1);
});

test('a streaming usage event followed by context-like failure must never trigger replay', async () => {
  let normal = 0, summary = 0;
  const model = { async *stream({ purpose }) {
    if (purpose === 'compact') { summary++; return; }
    normal++;
    yield { type: 'usage', usage: { input_tokens: 100 } };
    throw overflow();
  } };
  const compact = createAutoCompact({ thresholdTokens: 200000 });
  const loop = new AgentLoop({ model, compactContext: x => compact.compact(x) });
  await assert.rejects(loop.run({ messages: history, input: 'continue' }), ModelContextLengthError);
  assert.equal(normal, 1); assert.equal(summary, 0);
});

test('partial tool_use followed by error cannot compact or execute the tool', async () => {
  let normal = 0, summary = 0, effects = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'Edit', description: 'fixture', execute: async () => { effects++; } });
  const model = { async *stream({ purpose }) {
    if (purpose === 'compact') { summary++; return; }
    normal++;
    yield { type: 'tool_use', id: 'uncertain-edit', name: 'Edit', input: { file_path: 'math.js' } };
    throw overflow();
  } };
  const compact = createAutoCompact({ thresholdTokens: 200000 });
  await assert.rejects(new AgentLoop({
    model, tools, compactContext: x => compact.compact(x),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  }).run({ messages: history, input: 'continue' }), ModelContextLengthError);
  assert.equal(normal, 1); assert.equal(summary, 0); assert.equal(effects, 0);
});

test('disabled and ineligible compaction refuses recovery and keeps original failure', async () => {
  for (const messages of [history, [user('short')]]) {
    const compact = createAutoCompact({ thresholdTokens: messages === history ? 0 : 5000 });
    let summary = 0, normal = 0;
    const loop = new AgentLoop({
      model: { async *stream({ purpose }) {
        if (purpose === 'compact') { summary++; return; }
        normal++; throw overflow();
      } },
      compactContext: ctx => compact.compact(ctx),
    });
    await assert.rejects(loop.run({ messages, input: 'continue' }), ModelContextLengthError);
    assert.equal(normal, 1); assert.equal(summary, 0);
  }
});

test('summary itself exceeds context: truncate whole oldest round and preserve signed tail', async () => {
  const calls = [];
  let n = 0;
  const model = { async *stream({ messages, purpose, tools }) {
    assert.equal(purpose, 'compact');
    calls.push(structuredClone(messages));
    assert.deepEqual(tools, []);
    if (n++ === 0) throw overflow();
    assert.equal(messages[0].role, 'user');
    assert.match(messages[0].content, /Older conversation rounds omitted/);
    assert.equal(messages[1].content[0].signature, 'signed-edit-1');
    yield { type: 'text_delta', text: 'Earlier Edit completed and was verified, do not rerun.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const compact = createAutoCompact({ thresholdTokens: 999999 });
  const result = await compact.compact({ messages: history, model, force: true });
  assert.equal(result.compacted, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.messages.slice(1), history.slice(3));
});

test('summary streaming failure never retries and cannot commit a fake transcript', async () => {
  let summary = 0, normal = 0, commits = 0;
  const model = { async *stream({ purpose }) {
    if (purpose === 'compact') {
      summary++;
      yield { type: 'usage', usage: { input_tokens: 1 } };
      throw overflow();
    }
    normal++;
    throw overflow();
  } };
  const compact = createAutoCompact({ thresholdTokens: 999999 });
  const loop = new AgentLoop({ model, compactContext: c => compact.compact(c) });
  loop.on('contextCompacted', () => commits++);
  await assert.rejects(loop.run({ messages: history, input: 'continue' }), ModelContextLengthError);
  assert.equal(normal, 1);
  assert.equal(summary, 1);
  assert.equal(commits, 0);
});
