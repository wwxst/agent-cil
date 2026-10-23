import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  AnthropicMessagesAdapter,
  ModelAdapterError,
  parseSseStream,
} from '../src/anthropic-messages-adapter.js';

function makeSseBody(text, chunkSize = 13) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      }
    },
  };
}

function sse(type, payload) {
  return 'event: ' + type + '\r\ndata: ' + JSON.stringify({ type, ...payload }) + '\r\n\r\n';
}

function successfulStream() {
  return [
    sse('message_start', { message: { usage: { input_tokens: 3 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'echo', input: {} } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"value":"ok"}' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
    sse('message_stop', {}),
  ].join('');
}

test('parses SSE events across split UTF-8 chunks and CRLF boundaries', async () => {
  const stream = makeSseBody('event: greeting\r\ndata: 你好\r\ndata: second line\r\n\r\n', 2);
  const events = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  assert.deepEqual(events, [{ event: 'greeting', data: '你好\nsecond line' }]);
});

test('parses valid SSE streams that use lone CR line endings', async () => {
  const stream = makeSseBody('event: greeting\rdata: first\rdata: second\r\r', 1);
  const events = [];
  for await (const event of parseSseStream(stream)) events.push(event);
  assert.deepEqual(events, [{ event: 'greeting', data: 'first\nsecond' }]);
});

test('converts Messages API text, tool JSON deltas, usage, and stop reason', async () => {
  let request;
  let keyProviderCalls = 0;
  const adapter = new AnthropicMessagesAdapter({
    apiKeyProvider: async () => { keyProviderCalls += 1; return 'test-secret-key'; },
    model: 'claude-test-model',
    maxTokens: 256,
    system: 'Be concise.',
    baseUrl: 'https://api.example.test/',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, body: makeSseBody(successfulStream(), 7) };
    },
  });
  const events = [];
  for await (const event of adapter.stream({
    messages: [{ role: 'user', content: 'say hello' }],
    tools: [{
      name: 'echo',
      description: 'Return a value.',
      input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }],
  })) events.push(event);

  assert.equal(keyProviderCalls, 1);
  assert.equal(request.url, 'https://api.example.test/v1/messages');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-api-key'], 'test-secret-key');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.options.headers.accept, 'text/event-stream');
  assert.equal(request.options.redirect, 'error', 'API-key requests must not follow redirects to an untrusted endpoint');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'claude-test-model');
  assert.equal(body.max_tokens, 256);
  assert.equal(body.stream, true);
  assert.equal(body.system, 'Be concise.');
  assert.equal(body.messages[0].content, 'say hello');
  assert.equal(body.tools[0].name, 'echo');
  assert.equal(body.tools[0].input_schema.type, 'object');
  assert.equal(request.options.body.includes('test-secret-key'), false);

  assert.deepEqual(events.map(event => event.type), [
    'usage', 'text_delta', 'tool_use', 'usage', 'message_end',
  ]);
  assert.equal(events[1].text, '你好');
  assert.deepEqual(events[2], {
    type: 'tool_use', id: 'tool-1', name: 'echo', input: { value: 'ok' },
  });
  assert.deepEqual(events[3].usage, { input_tokens: 3, output_tokens: 5 });
  assert.deepEqual(events[4], { type: 'message_end', stopReason: 'tool_use' });
});

test('maps stop_sequence to a normal end_turn for the loop contract', async () => {
  const body = [
    sse('message_start', { message: { usage: { input_tokens: 1 } } }),
    sse('message_delta', { delta: { stop_reason: 'stop_sequence' }, usage: { output_tokens: 1 } }),
    sse('message_stop', {}),
  ].join('');
  const adapter = new AnthropicMessagesAdapter({
    apiKey: 'key',
    model: 'claude-test',
    fetchImpl: async () => ({ ok: true, status: 200, body: makeSseBody(body) }),
  });
  const events = [];
  for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(event);
  assert.deepEqual(events.at(-1), { type: 'message_end', stopReason: 'end_turn' });
});

test('rejects malformed tool input JSON and unsupported server-side tool use', async () => {
  const malformed = [
    sse('message_start', { message: { usage: {} } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool-bad', name: 'echo', input: {} } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{bad' } }),
    sse('content_block_stop', { index: 0 }),
  ].join('');
  const adapter = new AnthropicMessagesAdapter({
    apiKey: 'key',
    model: 'claude-test',
    fetchImpl: async () => ({ ok: true, status: 200, body: makeSseBody(malformed) }),
  });
  await assert.rejects(async () => {
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) void event;
  }, /invalid partial tool input JSON/);

  const serverTool = [
    sse('message_start', { message: { usage: {} } }),
    sse('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'server-1', name: 'web_search' } }),
  ].join('');
  const unsupported = new AnthropicMessagesAdapter({
    apiKey: 'key',
    model: 'claude-test',
    fetchImpl: async () => ({ ok: true, status: 200, body: makeSseBody(serverTool) }),
  });
  await assert.rejects(async () => {
    for await (const event of unsupported.stream({ messages: [{ role: 'user', content: 'hi' }] })) void event;
  }, /Server-side tool use is not supported/);
});

test('surfaces structured HTTP errors without logging request credentials', async () => {
  const adapter = new AnthropicMessagesAdapter({
    apiKey: 'secret',
    model: 'claude-test',
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { type: 'rate_limit_error', message: 'Slow down.' } }),
    }),
  });
  await assert.rejects(async () => {
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) void event;
  }, error => {
    assert.ok(error instanceof ModelAdapterError);
    assert.match(error.message, /HTTP 429/);
    assert.match(error.message, /Slow down/);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

test('honors cancellation before starting a request', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalled = false;
  const adapter = new AnthropicMessagesAdapter({
    apiKey: 'key',
    model: 'claude-test',
    fetchImpl: async () => { fetchCalled = true; throw new Error('should not fetch'); },
  });
  await assert.rejects(async () => {
    for await (const event of adapter.stream({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    })) void event;
  }, { name: 'AbortError' });
  assert.equal(fetchCalled, false);
});

test('rejects invalid constructor configuration and API-key provider output', async () => {
  assert.throws(() => new AnthropicMessagesAdapter({ model: 'x' }), /Provide apiKey or apiKeyProvider/);
  assert.throws(() => new AnthropicMessagesAdapter({ apiKey: 'key', model: 'x', baseUrl: 'file:///tmp' }), /HTTP or HTTPS/);
  assert.throws(
    () => new AnthropicMessagesAdapter({ apiKey: 'key', model: 'x', baseUrl: 'http://api.example.test' }),
    /must use HTTPS unless it targets localhost or a loopback address/,
  );
  assert.doesNotThrow(() => new AnthropicMessagesAdapter({
    apiKey: 'key', model: 'x', baseUrl: 'http://127.0.0.1:4312',
  }));
  assert.doesNotThrow(() => new AnthropicMessagesAdapter({
    apiKey: 'key', model: 'x', baseUrl: 'http://localhost:4312',
  }));
  assert.doesNotThrow(() => new AnthropicMessagesAdapter({
    apiKey: 'key', model: 'x', baseUrl: 'http://[::1]:4312',
  }));

  const adapter = new AnthropicMessagesAdapter({
    apiKeyProvider: async () => '',
    model: 'claude-test',
    fetchImpl: async () => { throw new Error('should not fetch'); },
  });
  await assert.rejects(async () => {
    for await (const event of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) void event;
  }, /did not return a non-empty key/);
});


test('integrates with AgentLoop across tool_result and the next API request', async () => {
  const requests = [];
  const toolResponse = [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'api-tool-1', name: 'echo', input: {} } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"value":"from api"}' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }),
    sse('message_stop', {}),
  ].join('');
  const finalResponse = [
    sse('message_start', { message: { usage: { input_tokens: 7 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'tool result received' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }),
    sse('message_stop', {}),
  ].join('');

  const model = new AnthropicMessagesAdapter({
    apiKey: 'fake-key',
    model: 'claude-test',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const responseBody = requests.length === 1 ? toolResponse : finalResponse;
      return { ok: true, status: 200, body: makeSseBody(responseBody, 19) };
    },
  });
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'Echo a value.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    execute: async ({ value }) => 'tool says: ' + value,
  });
  const loop = new AgentLoop({
    model,
    tools,
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });

  const result = await loop.run({ input: 'Use the echo tool.' });
  assert.equal(result.turns, 2);
  assert.equal(result.finalMessage.content[0].text, 'tool result received');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages[1].content[0].type, 'tool_use');
  assert.equal(requests[1].messages[1].content[0].id, 'api-tool-1');
  assert.equal(requests[1].messages[2].content[0].type, 'tool_result');
  assert.equal(requests[1].messages[2].content[0].content, 'tool says: from api');
  assert.equal(Object.hasOwn(requests[1].messages[1], 'stop_reason'), false);
});

test('rejects out-of-order SSE frames and incompatible content deltas', async () => {
  const start = sse('message_start', { message: { usage: {} } });
  const textStart = sse('content_block_start', {
    index: 0, content_block: { type: 'text', text: '' },
  });
  const cases = [
    {
      name: 'content block before message_start',
      data: textStart,
      message: /before message_start/,
    },
    {
      name: 'duplicate message_start',
      data: start + start,
      message: /duplicate message_start/,
    },
    {
      name: 'message_delta before a content block closes',
      data: start + textStart + sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
      message: /unfinished content blocks/,
    },
    {
      name: 'tool JSON delta inside a text block',
      data: start + textStart + sse('content_block_delta', {
        index: 0, delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
      message: /incompatible content_block_delta for text/,
    },
    {
      name: 'text delta inside a tool block',
      data: start + sse('content_block_start', {
        index: 0, content_block: { type: 'tool_use', id: 't1', name: 'echo', input: {} },
      }) + sse('content_block_delta', {
        index: 0, delta: { type: 'text_delta', text: 'wrong block' },
      }),
      message: /incompatible content_block_delta for tool_use/,
    },
    {
      name: 'unsupported thinking block is not silently dropped',
      data: start + sse('content_block_start', {
        index: 0, content_block: { type: 'thinking', thinking: '' },
      }),
      message: /unsupported content block type: thinking/,
    },
    {
      name: 'unknown streaming event is not silently dropped',
      data: start + sse('unexpected_type', {}),
      message: /unsupported SSE event: unexpected_type/,
    },
  ];
  for (const scenario of cases) {
    const adapter = new AnthropicMessagesAdapter({
      apiKey: 'test-key',
      model: 'claude-test',
      fetchImpl: async () => ({
        ok: true, status: 200, body: makeSseBody(scenario.data, 3),
      }),
    });
    await assert.rejects(async () => {
      for await (const event of adapter.stream({
        messages: [{ role: 'user', content: 'hello' }],
      })) void event;
    }, scenario.message, scenario.name);
  }
});
