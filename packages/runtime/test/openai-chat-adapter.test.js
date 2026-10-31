import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAIChatAdapter, OpenAIChatError, mapChatMessages } from '../src/openai-chat-adapter.js';

const event = chunk => 'data: ' + JSON.stringify(chunk) + '\n\n';
const done = 'data: [DONE]\n\n';
const body = text => ({
  async *[Symbol.asyncIterator]() {
    const bytes = Buffer.from(text, 'utf8');
    for (let i = 0; i < bytes.length; i += 31) yield bytes.subarray(i, i + 31);
  },
});
const completion = (delta, finish_reason = null) => ({
  id: 'response-1', object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason }],
});

function makeAdapter(stream, requests, config = {}) {
  return new OpenAIChatAdapter({
    apiKey: 'fictional-openai-key', model: 'gpt-5.1',
    maxRetries: 0, baseUrl: 'https://api.openai.com/v1',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: 200, ok: true, body: body(stream) };
    },
    ...config,
  });
}
async function collect(adapter, messages = [{ role: 'user', content: 'work' }], tools = []) {
  const items = [];
  for await (const e of adapter.stream({ messages, tools })) items.push(e);
  return items;
}

test('maps mixed Anthropic Query history to OpenAI Chat tool roles without dropping results', () => {
  const mapped = mapChatMessages([
    { role: 'user', content: 'fix it' },
    { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'a.js' } },
      { type: 'tool_use', id: 'edit-2', name: 'Edit',
        input: { file_path: 'a.js', old_string: 'bad', new_string: 'good' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read-1', content: 'bad' },
      { type: 'tool_result', tool_use_id: 'edit-2', content: '{"edited":true}' },
    ] },
    { role: 'user', content: 'explain results' },
  ], 'You are an engineer.');
  assert.equal(mapped[0].role, 'system');
  assert.deepEqual(mapped.map(x => x.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(mapped[2].content, 'checking');
  assert.deepEqual(mapped[2].tool_calls[0], {
    id: 'read-1', type: 'function',
    function: { name: 'Read', arguments: '{"file_path":"a.js"}' },
  });
  assert.equal(mapped[3].tool_call_id, 'read-1');
  assert.equal(mapped[4].content, '{"edited":true}');
});

test('OpenAI stream sends Bearer auth, schema tools, and reconstructs split function deltas', async () => {
  const requests = [];
  const stream = [
    event(completion({ role: 'assistant' })),
    event(completion({ content: 'I will inspect. ' })),
    event(completion({ tool_calls: [{ index: 0, id: 'call_read_123', type: 'function',
      function: { name: 'Read', arguments: '{"file_' } }] })),
    event(completion({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.js"}' } }] })),
    event(completion({}, 'tool_calls')),
    event({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 } }),
    done,
  ].join('');
  const adapter = makeAdapter(stream, requests, { system: 'act as developer', maxTokens: 250 });
  const events = await collect(adapter, [{ role: 'user', content: 'read a.js' }], [{
    name: 'Read', description: 'Read file', input_schema: { type: 'object' },
  }]);
  assert.deepEqual(events.map(x => x.type),
    ['text_delta', 'tool_use', 'usage', 'message_end']);
  assert.deepEqual(events[1], {
    type: 'tool_use', id: 'call_read_123', name: 'Read',
    input: { file_path: 'a.js' },
  });
  assert.equal(events[3].stopReason, 'tool_use');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
  const headers = requests[0].options.headers;
  assert.equal(headers.authorization, 'Bearer fictional-openai-key');
  assert.equal(Object.hasOwn(headers, 'x-api-key'), false);
  const req = JSON.parse(requests[0].options.body);
  assert.equal(req.model, 'gpt-5.1');
  assert.equal(req.stream, true);
  assert.equal(req.max_completion_tokens, 250);
  assert.equal(req.tools[0].type, 'function');
  assert.equal(req.tools[0].function.name, 'Read');
  assert.equal(req.messages[0].role, 'system');
});

test('OpenAI text-only completion and length are normalized for 2.1.88 Query', async () => {
  const stream = event(completion({ content: 'hello' })) +
    event(completion({}, 'length')) + done;
  const events = await collect(makeAdapter(stream, []));
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'hello' },
    { type: 'message_end', stopReason: 'max_tokens' },
  ]);
});

test('OpenAI streaming failures and forged/partial tool arguments fail closed', async () => {
  const invalid = [
    event(completion({ tool_calls: [{ index: 0, id: 'tool-1',
      function: { name: 'Read', arguments: '{"file_path":' } }] })) +
      event(completion({}, 'tool_calls')) + done,
    event(completion({ tool_calls: [{ index: 0, id: 'tool-1',
      function: { name: 'Read', arguments: '[]' } }] })) +
      event(completion({}, 'tool_calls')) + done,
    event(completion({ content: 'incomplete' })),
    event(completion({ content: 'end' })) + event(completion({}, 'stop')) +
      event(completion({ content: 'should not continue' })) + done,
  ];
  for (const stream of invalid) {
    const adapter = makeAdapter(stream, []);
    await assert.rejects(collect(adapter), OpenAIChatError);
  }
});

test('non-2xx Chat API response does not echo authorization header or retry 401', async () => {
  let calls = 0;
  const adapter = new OpenAIChatAdapter({
    apiKey: 'fictional-key-do-not-leak', model: 'gpt-5.1', maxRetries: 1,
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 401,
        json: async () => ({ error: { message: 'Invalid API key' } }) };
    },
  });
  await assert.rejects(collect(adapter), error => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes('fictional-key-do-not-leak'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('OpenAI Chat adapter refuses non-HTTPS remote credential endpoints', () => {
  assert.throws(() => new OpenAIChatAdapter({
    apiKey: 'x', model: 'm', baseUrl: 'http://untrusted.example.test/v1',
  }), /HTTPS/);
});
