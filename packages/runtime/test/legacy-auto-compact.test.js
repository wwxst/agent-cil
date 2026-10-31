import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { normalizeMessagesForAPI } from '../src/legacy-query/normalize-messages-for-api.js';
import {
  createAutoCompact, estimateMessageTokens, groupMessagesByApiRound,
  selectCompletedPrefix, formatCompactSummary,
} from '../src/legacy-compact/auto-compact.js';

const user = text => ({ role: 'user', content: text });
const assistant = (id, sig) => ({ role: 'assistant', sourceMessageId: 'assistant-' + id, content: [
  { type: 'thinking', thinking: 'protected:' + id, signature: sig },
  { type: 'tool_use', id, name: 'Read', input: { path: id } },
] });
const result = (id, text) => ({ role: 'user', content: [
  { type: 'tool_result', tool_use_id: id, content: text },
] });
const raw = [
  user('please fix the project'),
  assistant('read-1', 'sig-1'), result('read-1', 'old read\n'.repeat(100)),
  assistant('read-2', 'sig-2'), result('read-2', 'more old reads\n'.repeat(100)),
  assistant('read-3', 'sig-3'), result('read-3', 'latest tool result'),
  user('continue repair'),
];
function successModel(calls) {
  return { async *stream({ messages, tools, purpose }) {
    calls.push({ messages, tools, purpose });
    yield { type: 'thinking', thinking: 'private scratchpad', signature: 'summary-private' };
    yield { type: 'text_delta', text: '<analysis>hide this reasoning</analysis>' };
    yield { type: 'text_delta', text: '<summary>Completed a prior read of old project files.</summary>' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
}

test('ported estimator counts text/tool results but not opaque signatures', () => {
  const a = [user('hi'), assistant('tool1', 'short'), result('tool1', 'data')];
  const b = structuredClone(a);
  b[1].content[0].signature = 'x'.repeat(100000);
  assert.equal(estimateMessageTokens(a), estimateMessageTokens(b));
  assert.ok(estimateMessageTokens(raw) > 300);
});

test('2.1.88 API-round grouping keeps same-ID assistant fragments together', () => {
  const sameId = [
    { role: 'assistant', sourceMessageId: 'same-response', content: [
      { type: 'tool_use', id: 'same-a', name: 'Read', input: {} },
    ] },
    result('same-a', 'first'),
    { role: 'assistant', sourceMessageId: 'same-response', content: [
      { type: 'tool_use', id: 'same-b', name: 'Read', input: {} },
    ] },
    result('same-b', 'second'),
  ];
  assert.deepEqual(groupMessagesByApiRound(sameId), [sameId]);

  const newResponse = [
    ...sameId.slice(0, 2),
    { role: 'assistant', sourceMessageId: 'next-response', content: [
      { type: 'tool_use', id: 'next', name: 'Read', input: {} },
    ] },
    result('next', 'next response'),
  ];
  assert.equal(groupMessagesByApiRound(newResponse).length, 2);
});

test('ported API-round grouping retains tool calls with their tool_result and signed thinking', () => {
  const groups = groupMessagesByApiRound(raw);
  assert.equal(groups.length, 4);
  const split = selectCompletedPrefix(raw, 2);
  assert.deepEqual(split.prefix, raw.slice(0, 3));
  assert.deepEqual(split.recent, raw.slice(3));
  assert.equal(split.recent[0].content[0].signature, 'sig-2');
  assert.equal(split.recent[2].content[0].signature, 'sig-3');
  const incomplete = raw.slice(0, -2);
  assert.equal(selectCompletedPrefix(incomplete, 2), null,
    'dangling tool_use must never be compacted');
});

test('successful tool-free summary replaces only completed prefix and preserves recent signed rounds', async () => {
  const calls = [];
  const compact = createAutoCompact({ thresholdTokens: 350 });
  const input = structuredClone(raw);
  const response = await compact.compact({ messages: input, model: successModel(calls) });
  assert.equal(response.compacted, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tools, []);
  assert.equal(calls[0].purpose, 'compact');
  assert.deepEqual(
    calls[0].messages.slice(0, -1),
    normalizeMessagesForAPI(raw.slice(0, 3)),
    'summary requests use the provider projection, not transcript-only assistant IDs',
  );
  assert.ok(calls[0].messages.every(message =>
    !Object.hasOwn(message, 'sourceMessageId') && !Object.hasOwn(message, 'id')),
  'transcript-only assistant IDs must not leak into the summary provider request');
  assert.deepEqual(response.messages.slice(1), raw.slice(3));
  assert.equal(response.messages[0].role, 'user');
  assert.match(response.messages[0].content, /Completed a prior read/);
  assert.doesNotMatch(response.messages[0].content, /hide this reasoning|summary-private/);
  assert.ok(response.compactedTokens < response.estimatedTokens * 0.8);
  assert.deepEqual(input, raw, 'original history is immutable');
});

test('summary rejects tool calls and malformed end without altering messages', async () => {
  const src = structuredClone(raw);
  for (const events of [
    [{ type: 'tool_use', id: 'illegal', name: 'Write', input: { file_path: 'a' } },
      { type: 'message_end', stopReason: 'tool_use' }],
    [{ type: 'text_delta', text: 'partial summary' }],
    [{ type: 'text_delta', text: 'complete but truncated' },
      { type: 'message_end', stopReason: 'max_tokens' }],
  ]) {
    const compact = createAutoCompact({ thresholdTokens: 350 });
    await assert.rejects(compact.compact({ messages: src, model: {
      async *stream() { for (const e of events) yield e; },
    } }), /summary|Summary|Unexpected/);
    assert.deepEqual(src, raw);
    assert.equal(compact.consecutiveFailures, 1);
  }
});

test('compact failure circuit breaker stops repeated API calls after three failures', async () => {
  let requests = 0;
  const compact = createAutoCompact({ thresholdTokens: 350 });
  const model = { async *stream() { requests++; throw new Error('provider rejected summary'); } };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(compact.compact({ messages: raw, model }), /provider rejected summary/);
  }
  const skipped = await compact.compact({ messages: raw, model });
  assert.equal(skipped.compacted, false);
  assert.equal(requests, 3);
  assert.deepEqual(skipped.messages, raw);
});

test('no summary request for below threshold or unsafe tool pairing', async () => {
  const calls = [];
  const compact = createAutoCompact({ thresholdTokens: 500000 });
  assert.equal((await compact.compact({ messages: raw, model: successModel(calls) })).compacted, false);
  assert.equal(calls.length, 0);
  const invalid = raw.slice(0, -2);
  const small = createAutoCompact({ thresholdTokens: 20 });
  assert.equal((await small.compact({ messages: invalid, model: successModel(calls) })).compacted, false);
  assert.equal(calls.length, 0);
});

test('cancellation during tool-free summary cannot commit any history', async () => {
  const controller = new AbortController();
  const compact = createAutoCompact({ thresholdTokens: 350 });
  const model = { async *stream() {
    yield { type: 'text_delta', text: 'some output' };
    controller.abort(new Error('user interrupted summary'));
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  await assert.rejects(compact.compact({ messages: raw, model, signal: controller.signal }),
    /user interrupted summary/);
  assert.equal(compact.consecutiveFailures, 0);
});

test('formatCompactSummary strips drafting scratchpad and retains summary', () => {
  assert.equal(formatCompactSummary('<analysis>private</analysis>\n<summary>facts</summary>'),
    'Summary:\nfacts');
});

test('AgentLoop reuses Query and never runs tools from compaction-only sampling', async () => {
  let modelTurns = 0, summaries = 0, reads = 0;
  const tools = new ToolRegistry();
  tools.register({ name: 'Read', description: 'Read fixture',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string' },
    }, required: ['path'] },
    execute: async () => { reads++; return 'fixture '.repeat(350); },
  });
  const model = { async *stream({ purpose, messages, tools: advertised }) {
    if (purpose === 'compact') {
      summaries++;
      assert.deepEqual(advertised, []);
      assert.ok(messages.every(message =>
        !Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'sourceMessageId')),
        'internal transcript assistant IDs must not leak into compact summary requests');
      yield { type: 'text_delta', text: 'Earlier successful reads completed in workspace; continue.' };
      yield { type: 'message_end', stopReason: 'end_turn' };
      return;
    }
    modelTurns++;
    if (modelTurns <= 3) {
      yield { type: 'thinking', thinking: 'hidden', signature: 'sig-' + modelTurns };
      yield { type: 'tool_use', id: 'read-' + modelTurns, name: 'Read',
        input: { path: 'a' + modelTurns } };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } else {
      assert.equal(messages[0].role, 'user');
      assert.match(messages[0].content, /Earlier successful reads/);
      assert.ok(messages.some(m => m.role === 'assistant' &&
        m.content?.[0]?.signature === 'sig-3'));
      yield { type: 'text_delta', text: 'Read task complete.' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
  const autoCompact = createAutoCompact({ thresholdTokens: 250 });
  const loop = new AgentLoop({
    model, tools, compactContext: ctx => autoCompact.compact(ctx),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  const commits = [];
  loop.on('contextCompacted', e => commits.push(e));
  const output = await loop.run({ input: 'Read project files' });
  assert.equal(output.stopReason, 'end_turn');
  assert.equal(reads, 3);
  assert.equal(summaries, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].committedMessages[0].role, 'user');
});


test('disabled compaction does not inspect or rewrite unsupported provider message payloads', async () => {
  const unsupported = [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    { type: 'text', text: 'look at this image' },
  ] }];
  const compact = createAutoCompact({ thresholdTokens: 0 });
  const result = await compact.compact({
    messages: unsupported,
    model: { async *stream() { throw new Error('summary must not be invoked'); } },
  });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, unsupported, 'disabled mode preserves object identity');
});
