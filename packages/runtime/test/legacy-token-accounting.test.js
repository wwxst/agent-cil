import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getTokenCountFromUsage, tokenCountFromLastAPIResponse,
  finalContextTokensFromLastResponse, messageTokenCountFromLastAPIResponse,
  getCurrentUsage, tokenCountWithEstimation,
} from '../src/legacy-compact/legacy-tokens.js';
import {
  hasCompleteApiUsage, tokenCountForCliMessages, currentUsageForCliMessages,
} from '../src/legacy-compact/legacy-token-adapter.js';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

const usage = { input_tokens: 100, output_tokens: 20,
  cache_creation_input_tokens: 7, cache_read_input_tokens: 30 };
const user = content => ({ role: 'user', content });
const assistant = (content, use) => ({ role: 'assistant', content, ...(use ? { usage: use } : {}) });

test('original 2.1.88 usage count includes cache, output and last response not SSE sums', () => {
  assert.equal(getTokenCountFromUsage(usage), 157);
  const history = [user('hello'), assistant([{ type: 'text', text: 'okay' }], usage)];
  assert.equal(tokenCountForCliMessages(history), 157);
  assert.deepEqual(currentUsageForCliMessages(history), usage);
  assert.equal(tokenCountFromLastAPIResponse([{
    type: 'assistant', message: { content: [{ type: 'text', text: 'okay' }], usage },
  }]), 157);
  assert.equal(messageTokenCountFromLastAPIResponse([{
    type: 'assistant', message: { content: [{ type: 'text', text: 'okay' }], usage },
  }]), 20);
});

test('only COMPLETE provider usage can anchor; partial SSE snapshots use fallback', () => {
  const partial = { input_tokens: 900000 };
  assert.equal(hasCompleteApiUsage(partial), false);
  assert.equal(hasCompleteApiUsage({ ...usage, output_tokens: 1.5 }), false);
  const history = [user('hello'), assistant([{ type: 'text', text: 'okay' }], partial)];
  assert.ok(tokenCountForCliMessages(history) < 100, 'partial usage cannot read as precise 900000');
  assert.equal(currentUsageForCliMessages(history), null);
  assert.equal(hasCompleteApiUsage(usage), true);
});

test('original tokenCountWithEstimation counts cache-aware API anchor plus new tool_result suffix', () => {
  const history = [
    user('initial'),
    assistant([{ type: 'tool_use', id: 'x', name: 'Read', input: {} }], usage),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'x'.repeat(400) }]),
  ];
  assert.equal(tokenCountForCliMessages(history), 157 + 100);
});

test('original split-API-response sibling anchor includes interleaved tool results', () => {
  const legacy = [
    { type: 'assistant', message: { id: 'response-1',
      content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }],
      usage: { input_tokens: 80, output_tokens: 20 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a',
      content: 'a'.repeat(160) }] } },
    { type: 'assistant', message: { id: 'response-1',
      content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }],
      usage: { input_tokens: 80, output_tokens: 20 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b',
      content: 'b'.repeat(240) }] } },
  ];
  assert.ok(tokenCountWithEstimation(legacy) > 200,
    'both tool results must be included, not only the last response sibling');
});

test('2.1.88 iterations final window excludes cache unlike billing context count', () => {
  const history = [{ type: 'assistant', message: {
    content: [{ type: 'text', text: 'result' }],
    usage: { ...usage, iterations: [
      { input_tokens: 220, output_tokens: 9 },
      { input_tokens: 280, output_tokens: 11 },
    ] },
  } }];
  assert.equal(finalContextTokensFromLastResponse(history), 291);
  delete history[0].message.usage.iterations;
  assert.equal(finalContextTokensFromLastResponse(history), 120);
});

test('real Query stores final usage snapshot on committed assistant after tool execution', async () => {
  const tools = new ToolRegistry();
  tools.register({ name: 'Read', description: 'Test read', execute: async () => 'read complete' });
  let rounds = 0;
  const model = { async *stream() {
    rounds++;
    if (rounds === 1) {
      yield { type: 'usage', usage: { input_tokens: 90, output_tokens: 0 } };
      yield { type: 'tool_use', id: 'read-1', name: 'Read', input: {} };
      yield { type: 'usage', usage };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
  const loop = new AgentLoop({ model, tools, permissionPolicy: async () => ({ behavior: 'allow' }) });
  const answer = await loop.run({ input: 'read it' });
  assert.equal(answer.messages[1].usage.input_tokens, 100);
  assert.equal(answer.messages[1].usage.output_tokens, 20);
  assert.equal(answer.messages[2].content[0].tool_use_id, 'read-1');
  assert.equal(tokenCountForCliMessages(answer.messages.slice(0, 3)),
    157 + Math.round('read complete'.length / 4));
});
