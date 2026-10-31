import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop, ModelProtocolError } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { normalizeMessagesForAPI } from '../src/legacy-query/normalize-messages-for-api.js';
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

test('ported message normalizer merges an empty-response output-recovery meta prompt at the source text seam', () => {
  const recovery = 'Output token limit hit. Resume directly — no apology, no recap of what you were doing.';
  const input = [
    { role: 'user', content: 'original request' },
    { role: 'user', isMeta: true, content: recovery },
  ];
  const normalized = normalizeMessagesForAPI(input);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0].content, [
    { type: 'text', text: 'original request\n' },
    { type: 'text', text: recovery },
  ]);
  assert.equal(input[0].content, 'original request',
    'provider normalization must not mutate the durable transcript');
});

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
  assert.deepEqual(result.messages.slice(-2).flatMap(m=>m.content)
    .map(b=>b.tool_use_id), ['a','b'],
    'original Query keeps one UUID-linked source result per tool');
  assert.deepEqual(normalizeMessagesForAPI(result.messages).at(-1).content
    .map(b=>b.content),['value:A','value:B']);
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


test('ported Query resumes max_tokens with the original bounded continuation prompt', async () => {
  const recovery = "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
  let requests = 0;
  const checkpoints = [];
  const recoveryEvents = [];
  const model = { async *stream({ messages }) {
    requests++;
    if (requests === 1) {
      yield { type: 'text_delta', text: 'The first part. ' };
      yield { type: 'message_end', stopReason: 'max_tokens' };
      return;
    }
    assert.equal(messages.at(-2).role, 'assistant');
    assert.equal(messages.at(-2).content[0].text, 'The first part. ');
    assert.equal(messages.at(-1).role, 'user');
    assert.equal(messages.at(-1).content, recovery);
    yield { type: 'text_delta', text: 'The continuation.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const loop = new AgentLoop({
    model,
    tools: registry(),
    permissionPolicy: async () => ({ behavior: 'allow' }),
    onSessionCheckpoint: checkpoint => checkpoints.push(checkpoint),
  });
  loop.on('outputLimitRecovery', event => recoveryEvents.push(event));
  const result = await loop.run({ input: 'Finish the answer.' });
  assert.equal(requests, 2);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.turns, 1, 'output recovery does not consume an agent tool turn');
  assert.equal(result.messages.at(-2).content, recovery);
  assert.deepEqual(recoveryEvents, [{ turn: 1, attempt: 1 }]);
  assert.ok(checkpoints.some(checkpoint =>
    checkpoint.kind === 'output_recovery' &&
    checkpoint.messages.at(-1)?.content === recovery),
  'the continuation prompt is durable before the retry request');
});

test('ported Query bounds max_tokens recovery to three retries and surfaces exhaustion', async () => {
  let requests = 0;
  let recoveryCount = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      requests++;
      yield { type: 'text_delta', text: 'partial ' + requests };
      yield { type: 'message_end', stopReason: 'max_tokens' };
    } },
    tools: registry(),
  });
  loop.on('outputLimitRecovery', () => recoveryCount++);
  const result = await loop.run({ input: 'Long answer.' });
  assert.equal(requests, 4, 'one initial response plus three bounded recovery attempts');
  assert.equal(recoveryCount, 3);
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.turns, 1);
  assert.equal(result.messages.filter(message =>
    message.role === 'user' && message.content === "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.").length, 3);
  assert.equal(result.messages.at(-1).isApiErrorMessage, true,
    'exhaustion is a terminal API error, not a pending user prompt');
  assert.equal(normalizeMessagesForAPI(result.messages).some(message =>
    message.isApiErrorMessage === true), false,
  'synthetic API errors must never be sent back to the provider');
});

test('ported Query does not run output-limit recovery before completing a tool batch', async () => {
  let requests = 0;
  const model = { async *stream({ messages }) {
    requests++;
    if (requests === 1) {
      yield { type: 'tool_use', id: 'max-token-read', name: 'Read', input: { key: 'file' } };
      yield { type: 'message_end', stopReason: 'max_tokens' };
      return;
    }
    assert.equal(messages.at(-1).role, 'user');
    assert.equal(messages.at(-1).content[0].tool_use_id, 'max-token-read');
    assert.notEqual(messages.at(-1).content, "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.");
    yield { type: 'text_delta', text: 'Tool result received.' };
    yield { type: 'message_end', stopReason: 'end_turn' };
  } };
  const loop = new AgentLoop({
    model,
    tools: registry(),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  const result = await loop.run({ input: 'Read the file.' });
  assert.equal(requests, 2);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.messages.at(-2).content[0].tool_use_id, 'max-token-read');
});


test('ported Query drains a tool heartbeat while the model response is still open', {
  timeout: 5000,
}, async () => {
  let resolveProgress;
  const progressSeen = new Promise(resolve => { resolveProgress = resolve; });
  let resolveToolFinished;
  const toolFinished = new Promise(resolve => { resolveToolFinished = resolve; });
  const checkpoints = [];
  let modelReachedMessageEnd = false;
  const events = [];
  const progressEvents = [];
  let executeCalls = 0;
  let progressCalls = 0;
  const model = { async *stream() {
    yield {
      type: 'tool_use', id: 'early-progress', name: 'Read',
      input: { key: 'file' },
    };
    await progressSeen;
    modelReachedMessageEnd = true;
    yield { type: 'message_end', stopReason: 'tool_use' };
    resolveToolFinished();
  } };
  const result = await query({
    messages: [], input: 'Read the file.',
    maxTurns: 1,
    model,
    tools: registry(),
    canStartToolDuringStream: async () => true,
    executeTool: async (toolUse, { onToolProgress }) => {
      executeCalls++;
      progressCalls++;
      onToolProgress({
        toolUseID: toolUse.id,
        data: { type: 'tool_heartbeat', toolUseId: toolUse.id, phase: 'reading' },
      });
      await toolFinished;
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: 'value:file',
      };
    },
    onSessionCheckpoint: async checkpoint => {
      if (checkpoint.kind === 'tool_pending') {
        assert.equal(modelReachedMessageEnd, true,
          'the assistant tool_use message must be complete before its durable checkpoint');
      }
      checkpoints.push(checkpoint.kind);
    },
    emit: (type, value) => {
      events.push(type);
      if (type === 'toolProgress') {
        progressEvents.push({
          afterMessageEnd: modelReachedMessageEnd,
          progress: value.progress,
        });
        assert.equal(modelReachedMessageEnd, false,
          'a tool heartbeat must drain before the model emits message_end');
        resolveProgress();
      }
    },
  });
  assert.equal(result.stopReason, 'max_turns');
  assert.deepEqual(checkpoints, ['tool_pending', 'tool']);
  assert.equal(result.messages.at(-1).content[0].tool_use_id, 'early-progress');
  assert.ok(events.includes('toolProgress'));
  assert.equal(executeCalls, 1, 'the speculative tool must execute exactly once');
  assert.equal(progressCalls, 1, 'the tool emitted one heartbeat');
  assert.deepEqual(progressEvents, [{
    afterMessageEnd: false,
    progress: {
      type: 'progress',
      toolUseID: 'early-progress',
      parentToolUseID: 'early-progress',
      data: { type: 'tool_heartbeat', toolUseId: 'early-progress', phase: 'reading' },
    },
  }], 'the heartbeat must be drained exactly once before message_end');
});


test('ordinary tool progress stays queued until a tool-completion drain after message_end', {
  timeout: 5000,
}, async () => {
  let resolveToolStarted;
  const toolStarted = new Promise(resolve => { resolveToolStarted = resolve; });
  let resolveToolFinished;
  const toolFinished = new Promise(resolve => { resolveToolFinished = resolve; });
  let modelReachedMessageEnd = false;
  const progressEvents = [];
  const model = { async *stream() {
    yield {
      type: 'tool_use', id: 'ordinary-progress', name: 'Read',
      input: { key: 'file' },
    };
    await toolStarted;
    modelReachedMessageEnd = true;
    yield { type: 'message_end', stopReason: 'tool_use' };
    resolveToolFinished();
  } };
  const result = await query({
    messages: [], input: 'Read the file.',
    maxTurns: 1,
    model,
    tools: registry(),
    canStartToolDuringStream: async () => true,
    executeTool: async (toolUse, { onToolProgress }) => {
      onToolProgress({
        toolUseID: toolUse.id,
        data: { type: 'read_progress', toolUseId: toolUse.id, phase: 'reading' },
      });
      resolveToolStarted();
      await toolFinished;
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: 'value:file',
      };
    },
    emit: (type, value) => {
      if (type === 'toolProgress') {
        progressEvents.push({
          afterMessageEnd: modelReachedMessageEnd,
          progress: value.progress,
        });
      }
    },
  });
  assert.equal(result.stopReason, 'max_turns');
  assert.deepEqual(progressEvents, [{
    afterMessageEnd: true,
    progress: {
      type: 'progress',
      toolUseID: 'ordinary-progress',
      parentToolUseID: 'ordinary-progress',
      data: { type: 'read_progress', toolUseId: 'ordinary-progress', phase: 'reading' },
    },
  }]);
});


test('stream failure after early tool progress aborts and drains speculative tool cleanup', {
  timeout: 5000,
}, async () => {
  let resolveProgress;
  const progressSeen = new Promise(resolve => { resolveProgress = resolve; });
  let toolAbortObserved = false;
  let toolFinished = false;
  const checkpoints = [];
  const model = { async *stream() {
    yield {
      type: 'tool_use', id: 'early-abort', name: 'Read',
      input: { key: 'file' },
    };
    await progressSeen;
    throw new Error('synthetic provider disconnect');
  } };
  await assert.rejects(query({
    messages: [], input: 'Read the file.',
    maxTurns: 1,
    model,
    tools: registry(),
    canStartToolDuringStream: async () => true,
    executeTool: async (toolUse, { signal, onToolProgress }) => {
      const aborted = new Promise(resolve => {
        const observeAbort = () => {
          toolAbortObserved = true;
          resolve();
        };
        if (signal.aborted) observeAbort();
        else signal.addEventListener('abort', observeAbort, { once: true });
      });
      onToolProgress({
        toolUseID: toolUse.id,
        data: { type: 'tool_heartbeat', toolUseId: toolUse.id, phase: 'reading' },
      });
      await aborted;
      toolFinished = true;
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: 'value:file',
      };
    },
    onSessionCheckpoint: async checkpoint => {
      checkpoints.push(checkpoint.kind);
    },
    emit: type => {
      if (type === 'toolProgress') resolveProgress();
    },
  }), /synthetic provider disconnect/);
  assert.equal(toolAbortObserved, true, 'the speculative tool signal must be aborted');
  assert.equal(toolFinished, true, 'the query must await tool cleanup before surfacing the stream error');
  assert.ok(!checkpoints.includes('tool_pending'),
    'an incomplete assistant tool_use message must not be durably committed');
  assert.ok(!checkpoints.includes('tool'),
    'a discarded speculative tool result must not be durably committed');
});
