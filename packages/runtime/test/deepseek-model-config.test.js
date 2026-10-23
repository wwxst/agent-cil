import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicMessagesAdapter } from '../src/anthropic-messages-adapter.js';

function sse(type, fields = {}) {
  return 'event: ' + type + '\n' +
    'data: ' + JSON.stringify({ type, ...fields }) + '\n\n';
}

test('official DeepSeek V4.1 Flash model ID passes unchanged to Anthropic-compatible endpoint', async () => {
  const requests = [];
  const fakeSse = [
    sse('message_start', { message: { usage: { input_tokens: 5 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'READY' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const adapter = new AnthropicMessagesAdapter({
    apiKey: 'mock-key-not-real',
    model: 'deepseek-flash',
    maxTokens: 64,
    baseUrl: 'https://api.deepseek.com/anthropic',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true, status: 200,
        body: { async *[Symbol.asyncIterator]() { yield Buffer.from(fakeSse); } },
      };
    },
  });
  const events = [];
  for await (const e of adapter.stream({
    messages: [{ role: 'user', content: 'Reply READY' }],
    tools: [{ name: 'Read', description: 'Read file',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  })) events.push(e);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: 'deepseek-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Reply READY' }],
    stream: true,
    tools: [{ name: 'Read', description: 'Read file',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  });
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.get('x-api-key'), 'mock-key-not-real');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.has('x-client-request-id'), false,
    'DeepSeek-compatible gateway must not receive Anthropic first-party tracing header.');
  assert.equal(events.find(e => e.type === 'text_delta')?.text, 'READY');
  assert.equal(events.at(-1).stopReason, 'end_turn');
});
