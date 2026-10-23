import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  createAutoCompact, estimateMessageTokens, groupMessagesByApiRound,
  selectCompletedPrefix, formatCompactSummary,
} from '../src/legacy-compact/auto-compact.js';

const user = text => ({ role: 'user', content: text });
const assistant = (id, sig) => ({ role: 'assistant', content: [
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

test('proactive compact waits when protected recent rounds dominate the context', async () => {
  const messages = [user('task'), assistant('old', 'sig-old'), result('old', 'done'),
    assistant('recent1', 'sig1'), result('recent1', 'large output '.repeat(3000)),
    assistant('recent2', 'sig2'), result('recent2', 'fresh result')];
  const snapshot = structuredClone(messages);
  const compact = createAutoCompact({ thresholdTokens: 100 });
  let calls = 0;
  const model = { async *stream() { calls++; throw new Error('must not sample'); } };
  const output = await compact.compact({ messages, model });
  assert.equal(output.compacted, false);
  assert.deepEqual(output.messages, snapshot);
  assert.equal(calls, 0);
  assert.equal(compact.consecutiveFailures, 0);
  // Genuine overflow must still attempt the bounded recovery path.
  await assert.rejects(compact.compact({ messages, model, force: true }), /must not sample/);
  assert.equal(calls, 1);
});
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
  assert.deepEqual(calls[0].messages.slice(0, -1), raw.slice(0, 3));
  assert.deepEqual(response.messages.slice(1), raw.slice(3));
  assert.equal(response.messages[0].role, 'user');
  assert.match(response.messages[0].content, /Completed a prior read/);
  assert.doesNotMatch(response.messages[0].content, /hide this reasoning|summary-private/);
  assert.ok(response.compactedTokens < response.estimatedTokens * 0.8);
  assert.deepEqual(input, raw, 'original history is immutable');
});

test('2.1.88 proactive fallback ignores unsafe or incomplete summaries without altering messages', async () => {
  const src = structuredClone(raw);
  for (const events of [
    [{ type: 'tool_use', id: 'illegal', name: 'Write', input: { file_path: 'a' } },
      { type: 'message_end', stopReason: 'tool_use' }],
    [{ type: 'text_delta', text: 'partial summary' }],
    [{ type: 'text_delta', text: 'complete but truncated' },
      { type: 'message_end', stopReason: 'max_tokens' }],
  ]) {
    const compact = createAutoCompact({ thresholdTokens: 350 });
    const outcome = await compact.compact({ messages: src, model: {
      async *stream() { for (const e of events) yield e; },
    } });
    assert.equal(outcome.compacted, false);
    assert.equal(outcome.messages, src);
    assert.match(outcome.error.message, /summary|Summary|Unexpected/);
    assert.deepEqual(src, raw);
    assert.equal(compact.consecutiveFailures, 1);
  }
});

test('compact failure circuit breaker stops repeated API calls after three failures', async () => {
  let requests = 0;
  const compact = createAutoCompact({ thresholdTokens: 350 });
  const model = { async *stream() { requests++; throw new Error('provider rejected summary'); } };
  for (let i = 0; i < 3; i++) {
    const outcome = await compact.compact({ messages: raw, model });
    assert.equal(outcome.compacted, false);
    assert.match(outcome.error.message, /provider rejected summary/);
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


test('2.1.88 proactive summary quality failure does not abort a healthy multi-turn Query', async () => {
  const history = structuredClone(raw);
  const snapshot = structuredClone(history);
  let summaryRequests = 0, normalRequests = 0, contextErrors = 0;
  const autoCompact = createAutoCompact({ thresholdTokens: 300 });
  const model = { async *stream({ purpose, tools, messages }) {
    if (purpose === 'compact') {
      summaryRequests++;
      assert.deepEqual(tools, []);
      // Valid model completion, but an oversized summary cannot materially
      // shrink the request. Original autoCompactIfNeeded catches and resumes.
      yield { type: 'text_delta', text: 'redundant context '.repeat(700) };
      yield { type: 'message_end', stopReason: 'end_turn' };
      return;
    }
    normalRequests++;
    assert.deepEqual(messages, [...snapshot, user('continue')]);
    yield { type: 'text_delta', text: 'Healthy turn completed.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const loop = new AgentLoop({
    model,
    tools: new ToolRegistry(),
    compactContext: context => autoCompact.compact(context),
  });
  loop.on('contextCompactError', () => { contextErrors++; });
  const response = await loop.run({ messages: history, input: 'continue' });
  assert.equal(response.finalMessage.content[0].text, 'Healthy turn completed.');
  assert.equal(normalRequests, 1);
  assert.equal(summaryRequests, 1);
  assert.equal(contextErrors, 1);
  assert.equal(autoCompact.consecutiveFailures, 1);
  assert.deepEqual(history, snapshot);
});

test('minimum summary envelope prevents futile low-threshold proactive requests', async () => {
  let found;
  const stub = 'This conversation continues after context compaction. Earlier completed work:\n' +
    'x'.repeat(12) + '\nRecent messages follow unchanged.';
  // Search for a stable boundary where the old suffix-only 80% check would
  // pass yet the fixed summary envelope makes the goal impossible.
  for (let count = 1; count < 4000; count++) {
    const candidate = [
      user('task'),
      assistant('old', 'old-sig'), result('old', 'older output '.repeat(50)),
      assistant('newer', 'sig-n'), result('newer', 'r'.repeat(count)),
      assistant('fresh', 'sig-f'), result('fresh', 'short'),
    ];
    const split = selectCompletedPrefix(candidate, 2);
    if (!split) continue;
    const estimated = estimateMessageTokens(candidate);
    if (estimateMessageTokens(split.recent) < estimated * 0.8 &&
      estimateMessageTokens([user(stub), ...split.recent]) >= estimated * 0.8) {
      found = candidate;
      break;
    }
  }
  assert.ok(found, 'fixture must land strictly between old and fixed guards');
  const compact = createAutoCompact({ thresholdTokens: 100 });
  let calls = 0;
  const output = await compact.compact({
    messages: found,
    model: { async *stream() { calls++; throw new Error('unexpected summary call'); } },
  });
  assert.equal(output.compacted, false);
  assert.equal(output.messages, found);
  assert.equal(calls, 0);
  assert.equal(compact.consecutiveFailures, 0);
});

test('force=true retains explicit error propagation for unrecoverable provider overflow', async () => {
  const compact = createAutoCompact({ thresholdTokens: 300 });
  const model = { async *stream() { throw new Error('provider summary rejected'); } };
  await assert.rejects(compact.compact({ messages: raw, model, force: true }),
    /provider summary rejected/);
  assert.equal(compact.consecutiveFailures, 1);
});


test('2.1.304 rapid refill breaker stops a fourth compact within three internal rounds', async () => {
  const { RapidRefillBreakerError } = await import('../src/legacy-compact/auto-compact.js');
  const chainId = {};
  const controller = createAutoCompact({ thresholdTokens: 100 });
  let summaries = 0;
  const model = { async *stream({ purpose, tools }) {
    assert.equal(purpose, 'compact'); assert.deepEqual(tools, []);
    summaries++;
    yield { type: 'text_delta', text: 'Earlier work completed and checked successfully.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  for (let turn = 1; turn <= 3; turn++) {
    const output = await controller.compact({ messages: raw, model, chainId, turn });
    assert.equal(output.compacted, true);
  }
  await assert.rejects(controller.compact({
    messages: raw, model, chainId, turn: 4,
  }), error => error instanceof RapidRefillBreakerError &&
    error.code === 'rapid_refill_breaker_tripped');
  assert.equal(summaries, 3, 'fourth compaction must be stopped before provider call');
  // Another user prompt must not inherit a previous tool-chain breaker.
  const fresh = await controller.compact({ messages: raw, model, chainId: {}, turn: 1 });
  assert.equal(fresh.compacted, true);
  assert.equal(summaries, 4);
});

test('forced provider overflow can still compact after the proactive failure circuit opens', async () => {
  const controller = createAutoCompact({ thresholdTokens: 100 });
  let attempts = 0;
  const model = { async *stream({ purpose }) {
    assert.equal(purpose, 'compact');
    attempts++;
    if (attempts <= 3) throw new Error('network dropped summary response');
    yield { type: 'text_delta', text: 'All earlier tasks completed and checked.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  for (let i = 0; i < 3; i++) {
    const x = await controller.compact({ messages: raw, model });
    assert.equal(x.compacted, false);
  }
  assert.equal(controller.consecutiveFailures, 3);
  const forced = await controller.compact({ messages: raw, model, force: true });
  assert.equal(forced.compacted, true);
  assert.equal(attempts, 4);
});


test('2.1.88 measured usage counts cache input/output once and estimates only trailing tool messages', async () => {
  const { tokenCountWithEstimation, getTokenCountFromUsage } =
    await import('../src/legacy-compact/auto-compact.js');
  const measured = { input_tokens: 100, cache_read_input_tokens: 250,
    cache_creation_input_tokens: 50, output_tokens: 17 };
  assert.equal(getTokenCountFromUsage(measured), 417);
  const transcript = [
    user('an extremely long old conversation '.repeat(100)),
    { ...assistant('call', 'opaque'), usage: measured },
    result('call', 'new tool result'),
  ];
  assert.equal(tokenCountWithEstimation(transcript),
    417 + estimateMessageTokens(transcript.slice(2)));
  assert.ok(tokenCountWithEstimation(transcript) < estimateMessageTokens(transcript));
});

test('compaction clears only stale usage anchor, preserving signed recent content', async () => {
  const { tokenCountWithEstimation } =
    await import('../src/legacy-compact/auto-compact.js');
  const input = structuredClone(raw);
  input[4].usage = { input_tokens: 125000, output_tokens: 200 };
  const controller = createAutoCompact({ thresholdTokens: 60000 });
  let summaryCalls = 0;
  const model = { async *stream() {
    summaryCalls++;
    yield { type: 'text_delta', text: 'Earlier project reads finished without errors.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const answer = await controller.compact({ messages: input, model });
  assert.equal(answer.compacted, true);
  assert.equal(summaryCalls, 1);
  assert.equal(answer.contextTokens, tokenCountWithEstimation(input));
  assert.equal(answer.messages[2].usage, undefined,
    'retained pre-compact usage must not be reused');
  assert.equal(answer.messages[2].content[0].signature, 'sig-2');
  assert.equal(answer.messages[4].content[0].signature, 'sig-3');
  assert.equal(input[4].usage.input_tokens, 125000, 'source transcript is unchanged');
  assert.equal(tokenCountWithEstimation(answer.messages),
    estimateMessageTokens(answer.messages));
});

test('context-window and output reservation limit high configured compact threshold', async () => {
  const input = structuredClone(raw);
  input[4].usage = { input_tokens: 950, output_tokens: 5 };
  const controller = createAutoCompact({
    thresholdTokens: 2000,
    contextWindowTokens: 1100,
    reservedOutputTokens: 100,
    contextSafetyTokens: 25,
  });
  let summaries = 0;
  const model = { async *stream() {
    summaries++;
    yield { type: 'text_delta', text: 'Historical read operations completed successfully.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const result = await controller.compact({ messages: input, model });
  assert.equal(result.compacted, true);
  assert.equal(summaries, 1);
});
