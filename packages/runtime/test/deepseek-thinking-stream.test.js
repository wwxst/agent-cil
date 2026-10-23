import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicMessagesAdapter, ModelAdapterError } from '../src/anthropic-messages-adapter.js';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

const frame = (type, extra = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...extra }) + '\n\n';
const start = () => frame('message_start', { message: { usage: { input_tokens: 1 } } });
const open = (index, content_block) => frame('content_block_start', { index, content_block });
const delta = (index, payload) => frame('content_block_delta', { index, delta: payload });
const close = index => frame('content_block_stop', { index });
const end = reason => frame('message_delta', { delta: { stop_reason: reason } }) + frame('message_stop');
function streamBody(s, size = 17) {
  return { async *[Symbol.asyncIterator]() {
    const bytes = Buffer.from(s, 'utf8');
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
  } };
}
function adapterFor(streams, requests, baseUrl = 'https://api.deepseek.com/anthropic') {
  return new AnthropicMessagesAdapter({
    apiKey: 'fixture-key', model: 'deepseek-flash', maxRetries: 0,
    baseUrl,
    fetchImpl: async (url, args) => {
      requests.push({ url, body: JSON.parse(args.body) });
      return { ok: true, status: 200, body: streamBody(streams[requests.length - 1]) };
    },
  });
}
async function collect(model) {
  const events = [];
  for await (const item of model.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    events.push(item);
  }
  return events;
}
const withThinking = (signature = 'opaque-sig') =>
  start() +
  open(0, { type: 'thinking', thinking: '', signature: '' }) +
  delta(0, { type: 'thinking_delta', thinking: 'consider' }) +
  delta(0, { type: 'thinking_delta', thinking: ' tools' }) +
  delta(0, { type: 'signature_delta', signature }) +
  close(0) +
  open(1, { type: 'text', text: '' }) +
  delta(1, { type: 'text_delta', text: 'Hello' }) +
  close(1) + end('end_turn');

test('2.1.88 accumulator handles thinking_delta/signature_delta, keeping reasoning private', async () => {
  const requests = [];
  const events = await collect(adapterFor([withThinking()], requests));
  assert.deepEqual(events.filter(x => x.type !== 'usage'), [
    { type: 'thinking', thinking: 'consider tools', signature: 'opaque-sig' },
    { type: 'text_delta', text: 'Hello' },
    { type: 'message_end', stopReason: 'end_turn' },
  ]);
  assert.equal(requests[0].body.model, 'deepseek-flash');
});

test('DeepSeek missing signature is left absent rather than fabricated', async () => {
  const stream = start() +
    open(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'reasoning' }) + close(0) +
    open(1, { type: 'text', text: '' }) + delta(1, { type: 'text_delta', text: 'answer' }) +
    close(1) + end('end_turn');
  const events = await collect(adapterFor([stream], []));
  assert.deepEqual(events.filter(x => x.type === 'thinking'),
    [{ type: 'thinking', thinking: 'reasoning' }]);
});

test('Anthropic redacted_thinking is opaque and preserved with signed thinking', async () => {
  const content = start() +
    open(0, { type: 'redacted_thinking', data: 'opaque-encrypted-binary' }) + close(0) +
    open(1, { type: 'thinking', thinking: '' }) +
    delta(1, { type: 'thinking_delta', thinking: 'private' }) +
    delta(1, { type: 'signature_delta', signature: 'verifiable' }) + close(1) +
    open(2, { type: 'text', text: '' }) + delta(2, { type: 'text_delta', text: 'Public' }) +
    close(2) + end('end_turn');
  const events = await collect(adapterFor([content], [], 'https://api.anthropic.com'));
  assert.deepEqual(events.filter(x => x.type !== 'usage'), [
    { type: 'redacted_thinking', data: 'opaque-encrypted-binary' },
    { type: 'thinking', thinking: 'private', signature: 'verifiable' },
    { type: 'text_delta', text: 'Public' },
    { type: 'message_end', stopReason: 'end_turn' },
  ]);
});

test('thinking and signature survive exact multi-turn tool continuation, without textDelta leak', async () => {
  const first = start() +
    open(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'private-plan' }) +
    delta(0, { type: 'signature_delta', signature: 'signed-opaque-value' }) + close(0) +
    open(1, { type: 'text', text: '' }) + delta(1, { type: 'text_delta', text: 'Reading' }) + close(1) +
    open(2, { type: 'tool_use', id: 'read-1', name: 'Read', input: {} }) +
    delta(2, { type: 'input_json_delta', partial_json: '{"key":"file"}' }) + close(2) +
    end('tool_use');
  const second = start() +
    open(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'another-private-plan' }) +
    close(0) +
    open(1, { type: 'text', text: '' }) +
    delta(1, { type: 'text_delta', text: 'Finished' }) + close(1) + end('end_turn');
  const requests = [];
  const tools = new ToolRegistry();
  tools.register({ name: 'Read', description: 'Read fixture', inputSchema: {
    type: 'object', properties: { key: { type: 'string' } }, required: ['key'],
  }, execute: async input => 'file:' + input.key });
  const model = adapterFor([first, second], requests);
  const loop = new AgentLoop({
    model, tools, permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  const printed = [];
  loop.on('textDelta', ({ text }) => printed.push(text));
  const result = await loop.run({ input: 'read file' });
  assert.deepEqual(printed, ['Reading', 'Finished']);
  assert.deepEqual(requests[1].body.messages[1].content, [
    { type: 'thinking', thinking: 'private-plan', signature: 'signed-opaque-value' },
    { type: 'text', text: 'Reading' },
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { key: 'file' } },
  ]);
  assert.equal(requests[1].body.messages[2].content[0].content, 'file:file');
  assert.deepEqual(result.messages.at(-1).content, [
    { type: 'thinking', thinking: 'another-private-plan' },
    { type: 'text', text: 'Finished' },
  ]);
});

test('Anthropic tool continuation round-trips redacted_thinking byte-for-byte', async () => {
  const first = start() +
    open(0, { type: 'redacted_thinking', data: 'ciphertext-not-for-client' }) + close(0) +
    open(1, { type: 'tool_use', id: 'read-2', name: 'Read', input: {} }) +
    delta(1, { type: 'input_json_delta', partial_json: '{"key":"yes"}' }) + close(1) +
    end('tool_use');
  const next = start() + open(0, { type: 'text', text: '' }) +
    delta(0, { type: 'text_delta', text: 'done' }) + close(0) + end('end_turn');
  const requests = [], tools = new ToolRegistry();
  tools.register({ name: 'Read', description: 'Fixture', execute: async () => 'yes' });
  await new AgentLoop({
    model: adapterFor([first, next], requests, 'https://api.anthropic.com'),
    tools, permissionPolicy: async () => ({ behavior: 'allow' }),
  }).run({ input: 'read' });
  assert.deepEqual(requests[1].body.messages[1].content[0],
    { type: 'redacted_thinking', data: 'ciphertext-not-for-client' });
});

test('DeepSeek cannot silently remove unsupported redacted history on tool continuation', async () => {
  const first = start() +
    open(0, { type: 'redacted_thinking', data: 'unforwardable' }) + close(0) +
    open(1, { type: 'tool_use', id: 'read-3', name: 'Read', input: {} }) +
    delta(1, { type: 'input_json_delta', partial_json: '{"key":"a"}' }) +
    close(1) + end('tool_use');
  const requests = [], tools = new ToolRegistry();
  let executed = 0;
  tools.register({ name: 'Read', description: 'Fixture', execute: async () => {
    executed++;
    return 'x';
  } });
  await assert.rejects(new AgentLoop({
    model: adapterFor([first], requests),
    tools, permissionPolicy: async () => ({ behavior: 'allow' }),
  }).run({ input: 'read' }), /DeepSeek.*redacted_thinking/);
  assert.equal(requests.length, 1, 'must reject before a malformed second request');
  assert.equal(executed, 0, 'unsupported model blocks must not trigger tools');
});

test('stream protocol rejects unknown blocks, mismatched signature, malformed redaction and truncation', async () => {
  const bad = [
    start() + open(0, { type: 'unknown_thought', value: 1 }) + close(0) + end('end_turn'),
    start() + open(0, { type: 'text', text: '' }) +
      delta(0, { type: 'signature_delta', signature: 'bad' }) + close(0) + end('end_turn'),
    start() + open(0, { type: 'thinking', thinking: '' }) +
      delta(0, { type: 'text_delta', text: 'bad' }) + close(0) + end('end_turn'),
    start() + open(0, { type: 'redacted_thinking' }) + close(0) + end('end_turn'),
    start() + open(0, { type: 'thinking', thinking: '' }) +
      delta(0, { type: 'thinking_delta', thinking: 'incomplete' }),
  ];
  for (const stream of bad) {
    await assert.rejects(collect(adapterFor([stream], [])), ModelAdapterError);
  }
});
