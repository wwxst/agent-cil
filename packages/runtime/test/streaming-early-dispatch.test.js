import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop, ModelProtocolError } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

// Explicitly declare this test policy independent of partial assistant
// messages; production CLI does the same. Unmarked custom policies defer.
function earlyPermission(fn) {
  Object.defineProperty(fn, 'supportsStreamingPreflight', { value: true });
  return fn;
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function timely(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      'Read did not start while model stream was open')), 2500)),
  ]);
}
function registry({ read, write, bash, readonly = true } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'Read', description: 'Read a value from the workspace.',
    isConcurrencySafe: () => true, canRunDuringStream: readonly,
    inputSchema: { type: 'object', properties: {
      key: { type: 'string' },
    }, required: ['key'] },
    execute: read || (async ({ key }) => 'value:' + key),
  });
  tools.register({
    name: 'Write', description: 'Write a value to a file.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    execute: write || (async () => 'written'),
  });
  tools.register({
    name: 'Bash', description: 'Run an approved shell command.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: bash || (async () => 'completed'),
  });
  return tools;
}
const readUse = (id = 'read-1') => ({ type: 'tool_use', id, name: 'Read', input: { key: 'a' } });
const writeUse = (id = 'write-1') => ({ type: 'tool_use', id, name: 'Write', input: { key: 'a' } });
const bashUse = (id = 'bash-1') => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'node test.js' } });
const end = () => ({ type: 'message_end', stopReason: 'tool_use' });
const final = () => [{ type: 'text_delta', text: 'complete' },
  { type: 'message_end', stopReason: 'end_turn' }];

test('trusted Read starts before message_end, but tool result follows the completed assistant message', async () => {
  const started = gate(), order = [];
  let round = 0;
  const model = { async *stream({ messages }) {
    if (round++ === 0) {
      yield readUse();
      await timely(started.promise);
      order.push('model-end');
      yield end();
    } else {
      assert.equal(messages.at(-1).content[0].content, 'value:a');
      for (const event of final()) yield event;
    }
  } };
  const loop = new AgentLoop({
    model, tools: registry(),
    permissionPolicy: earlyPermission(async () => ({ behavior: 'allow' })),
  });
  loop.on('toolCallStarted', ({ toolName }) => {
    order.push('tool-start:' + toolName);
    started.release();
  });
  const result = await loop.run({ input: 'read' });
  assert.deepEqual(order, ['tool-start:Read', 'model-end']);
  assert.equal(result.turns, 2);
  assert.equal(result.messages[1].content[0].type, 'tool_use');
  assert.equal(result.messages[2].content[0].tool_use_id, 'read-1');
});

test('Write and Bash never run or request approval while model stream is incomplete', async () => {
  let ended = false, writes = 0, shells = 0, approvals = 0;
  const calls = [];
  let round = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      if (round++ === 0) {
        yield writeUse();
        yield bashUse();
        await Promise.resolve();
        assert.equal(writes + shells + approvals, 0);
        ended = true;
        yield end();
      } else { for (const event of final()) yield event; }
    } },
    tools: registry({
      write: async () => { assert.ok(ended); writes++; return 'written'; },
      bash: async () => { assert.ok(ended); shells++; return 'tested'; },
    }),
    permissionPolicy: earlyPermission(async ({ name }) => ({
      behavior: name === 'Write' || name === 'Bash' ? 'ask' : 'allow',
    })),
    approvalHandler: async ({ name }) => {
      assert.ok(ended, 'approval must not open before stream end');
      calls.push(name); approvals++;
      return { approved: true };
    },
  });
  const result = await loop.run({ input: 'edit and test' });
  assert.equal(result.turns, 2);
  assert.equal(writes, 1); assert.equal(shells, 1);
  assert.deepEqual(calls, ['Write', 'Bash']);
});

test('an unsafe first tool blocks later Read speculation to preserve scheduler barriers', async () => {
  let ended = false, reads = 0, writes = 0, round = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      if (round++ === 0) {
        yield writeUse();
        yield readUse();
        await Promise.resolve();
        assert.equal(reads, 0);
        assert.equal(writes, 0);
        ended = true;
        yield end();
      } else { for (const event of final()) yield event; }
    } },
    tools: registry({
      read: async () => { assert.ok(ended); reads++; return 'read'; },
      write: async () => { assert.ok(ended); writes++; return 'write'; },
    }),
    permissionPolicy: earlyPermission(async () => ({ behavior: 'allow' })),
  });
  await loop.run({ input: 'write then read' });
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test('Read needing approval is deferred; no permissionRequired before message_end', async () => {
  let ended = false, approvals = 0, reads = 0, round = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      if (round++ === 0) {
        yield readUse();
        await Promise.resolve();
        assert.equal(approvals, 0);
        assert.equal(reads, 0);
        ended = true;
        yield end();
      } else { for (const event of final()) yield event; }
    } },
    tools: registry({ read: async () => { reads++; return 'read'; } }),
    permissionPolicy: earlyPermission(async () => ({ behavior: 'ask' })),
    approvalHandler: async () => { assert.ok(ended); approvals++; return true; },
  });
  await loop.run({ input: 'read protected file' });
  assert.equal(approvals, 1);
  assert.equal(reads, 1);
});

test('changed permission after preflight never triggers early approval or side effects', async () => {
  let approvalCalls = 0, reads = 0, decisionCalls = 0, round = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      if (round++ === 0) {
        yield readUse();
        yield end();
      } else { for (const event of final()) yield event; }
    } },
    tools: registry({ read: async () => { reads++; return 'read'; } }),
    permissionPolicy: earlyPermission(async () => ({
      behavior: ++decisionCalls === 1 ? 'allow' : 'ask',
    })),
    approvalHandler: async () => { approvalCalls++; return true; },
  });
  const result = await loop.run({ input: 'read' });
  assert.equal(reads, 0);
  assert.equal(approvalCalls, 0);
  assert.equal(result.messages[2].content[0].is_error, true);
});

test('truncated stream discards an early Read and aborts its signal without executing writes', async () => {
  const started = gate(), aborted = gate();
  let writeCount = 0, round = 0;
  const messages = [{ role: 'user', content: 'previous' }];
  const loop = new AgentLoop({
    model: { async *stream() {
      if (round++ === 0) {
        yield readUse();
        await timely(started.promise);
        yield writeUse(); // must not execute before complete message
        throw new ModelProtocolError('SSE connection lost');
      }
    } },
    tools: registry({
      read: async (_, { signal }) => {
        started.release();
        await new Promise(resolve => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', resolve, { once: true });
        });
        aborted.release();
        return 'aborted read';
      },
      write: async () => { writeCount++; return 'BAD'; },
    }),
    permissionPolicy: earlyPermission(async () => ({ behavior: 'allow' })),
  });
  await assert.rejects(loop.run({ messages, input: 'start' }), /SSE connection lost/);
  await timely(aborted.promise);
  assert.equal(writeCount, 0);
  assert.deepEqual(messages, [{ role: 'user', content: 'previous' }]);
  assert.equal(loop.active, false);
});

test('AbortSignal cancels early Read without scheduling later Write or altering history', async () => {
  const controller = new AbortController(), started = gate(), aborted = gate();
  let writes = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      yield readUse();
      await timely(started.promise);
      controller.abort(new Error('interrupted by user'));
      yield writeUse();
      yield end();
    } },
    tools: registry({
      read: async (_, { signal }) => {
        started.release();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        aborted.release();
        return 'aborted';
      },
      write: async () => { writes++; return 'BAD'; },
    }),
    permissionPolicy: earlyPermission(async () => ({ behavior: 'allow' })),
  });
  await assert.rejects(loop.run({ input: 'read', signal: controller.signal }), /interrupted by user/);
  await timely(aborted.promise);
  assert.equal(writes, 0);
});

test('unknown tool/invalid read-only metadata cannot opt into early execution', async () => {
  const tools = registry({ readonly: false });
  const reject = () => tools.register({
    name: 'Wrong', description: 'No concurrency indicator',
    canRunDuringStream: true, execute: async () => 'bad',
  });
  assert.throws(reject, /canRunDuringStream/);
  let executed = false, ended = false, round = 0;
  const loop = new AgentLoop({
    model: { async *stream() {
      if (round++ === 0) {
        yield readUse();
        assert.equal(executed, false);
        ended = true;
        yield end();
      } else { for (const event of final()) yield event; }
    } },
    tools: registry({
      readonly: false,
      read: async () => { assert.ok(ended); executed = true; return 'read'; },
    }),
    permissionPolicy: earlyPermission(async () => ({ behavior: 'allow' })),
  });
  await loop.run({ input: 'read' });
  assert.equal(executed, true);
});


test('two early safe reads overlap but their results preserve model order', async () => {
  const bothStarted = gate(), firstDone = gate();
  const observed = [];
  let running = 0, round = 0;
  const tools = registry({
    read: async ({ key }) => {
      running++;
      observed.push('started:' + key);
      if (running === 2) bothStarted.release();
      if (key === 'a') {
        await timely(bothStarted.promise);
        await timely(firstDone.promise);
      } else {
        firstDone.release();
      }
      running--;
      return 'value:' + key;
    },
  });
  const model = { async *stream({ messages }) {
    if (round++ === 0) {
      yield { type: 'tool_use', id: 'first', name: 'Read', input: { key: 'a' } };
      yield { type: 'tool_use', id: 'second', name: 'Read', input: { key: 'b' } };
      await timely(bothStarted.promise);
      yield end();
    } else {
      assert.deepEqual(messages.at(-1).content.map(x => x.tool_use_id), ['first', 'second']);
      assert.deepEqual(messages.at(-1).content.map(x => x.content), ['value:a', 'value:b']);
      for (const event of final()) yield event;
    }
  } };
  const loop = new AgentLoop({
    model, tools, permissionPolicy: earlyPermission(async () => ({ behavior: 'allow' })),
  });
  await loop.run({ input: 'read two files' });
  assert.deepEqual(observed.sort(), ['started:a', 'started:b']);
});

test('failed early Read cannot bypass a deferred Bash approval refusal', async () => {
  const readStarted = gate();
  let modelEnded = false, bashCount = 0, approvalCount = 0, round = 0;
  const model = { async *stream({ messages }) {
    if (round++ === 0) {
      yield readUse();
      yield bashUse();
      await timely(readStarted.promise);
      assert.equal(bashCount, 0);
      assert.equal(approvalCount, 0);
      modelEnded = true;
      yield end();
    } else {
      const result = messages.at(-1).content;
      assert.equal(result[0].is_error, true);
      assert.equal(result[1].is_error, true);
      for (const event of final()) yield event;
    }
  } };
  const loop = new AgentLoop({
    model,
    tools: registry({
      read: async () => {
        readStarted.release();
        throw new Error('read failed');
      },
      bash: async () => { bashCount++; return 'BAD'; },
    }),
    permissionPolicy: earlyPermission(async ({ name }) =>
      ({ behavior: name === 'Bash' ? 'ask' : 'allow' })),
    approvalHandler: async () => {
      assert.ok(modelEnded);
      approvalCount++;
      return { approved: false };
    },
  });
  const result = await loop.run({ input: 'inspect then run tests' });
  assert.equal(result.turns, 2);
  assert.equal(bashCount, 0);
  assert.equal(approvalCount, 1);
});


test('history-dependent permission policies cannot be previewed before assistant completion', async () => {
  let started = 0, ended = false, round = 0;
  const loop = new AgentLoop({
    model: { async *stream({ messages }) {
      if (round++ === 0) {
        yield { type: 'text_delta', text: 'assistant classified as forbidden' };
        yield readUse();
        await Promise.resolve();
        assert.equal(started, 0, 'unmarked policy must never authorize a partial assistant');
        ended = true;
        yield end();
      } else { for (const event of final()) yield event; }
    } },
    tools: registry({ read: async () => { started++; return 'secret'; } }),
    // This policy explicitly depends on the complete assistant message.
    permissionPolicy: async ({ messages }) => ({
      behavior: messages.at(-1)?.role === 'assistant' ? 'deny' : 'allow',
    }),
  });
  const result = await loop.run({ input: 'read forbidden content' });
  assert.equal(ended, true);
  assert.equal(started, 0, 'old post-message_end permission behavior must be preserved');
  assert.equal(result.messages[2].content[0].is_error, true);
});
