import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StreamingToolExecutor } from '../src/legacy-tools/streaming-tool-executor.js';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

const block = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const result = (id, content, is_error = false) => ({
  type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}),
});
const defer = () => {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('ported 2.1.88 scheduler runs safe reads concurrently and returns their results', async () => {
  const gates = { one: defer(), two: defer() };
  const started = [];
  const executor = new StreamingToolExecutor({
    getTool: () => ({ isConcurrencySafe: () => true }),
    execute: async b => {
      started.push(b.id);
      await gates[b.id].promise;
      return result(b.id, b.id);
    },
  });
  executor.addTool(block('one', 'Read'));
  executor.addTool(block('two', 'Read'));
  assert.deepEqual(started, ['one', 'two'], 'safe operations should not block one another');
  const received = (async () => {
    const ids = [];
    for await (const update of executor.getRemainingResults()) {
      if (update.message) ids.push(update.message.content[0].tool_use_id);
    }
    return ids;
  })();
  gates.two.resolve();
  await flush();
  gates.one.resolve();
  const ids = await received;
  assert.deepEqual(ids.slice().sort(), ['one', 'two']);
});

test('ported scheduler holds writes as exclusive barriers and preserves ordering', async () => {
  const gates = { first: defer(), write: defer(), last: defer() };
  const started = [];
  let active = 0;
  let peak = 0;
  const executor = new StreamingToolExecutor({
    getTool: name => ({ isConcurrencySafe: () => name === 'Read' }),
    execute: async b => {
      started.push(b.id);
      active += 1;
      peak = Math.max(peak, active);
      await gates[b.id].promise;
      active -= 1;
      return result(b.id, b.id);
    },
  });
  executor.addTool(block('first', 'Read'));
  executor.addTool(block('write', 'Write'));
  executor.addTool(block('last', 'Read'));
  assert.deepEqual(started, ['first'], 'exclusive queued tool blocks all subsequent reads');
  const received = (async () => {
    const ids = [];
    for await (const item of executor.getRemainingResults()) {
      if (item.message) ids.push(item.message.content[0].tool_use_id);
    }
    return ids;
  })();
  gates.first.resolve();
  await flush();
  assert.deepEqual(started, ['first', 'write']);
  gates.write.resolve();
  await flush();
  assert.deepEqual(started, ['first', 'write', 'last']);
  gates.last.resolve();
  assert.deepEqual(await received, ['first', 'write', 'last']);
  assert.equal(peak, 1, 'non-safe tool must not overlap either read');
});

test('ported scheduler synthesizes sibling failures after Bash errors without invoking queued tools', async () => {
  const invoked = [];
  const executor = new StreamingToolExecutor({
    getTool: name => ({ isConcurrencySafe: () => name === 'Read' }),
    execute: async b => {
      invoked.push(b.id);
      return result(b.id, b.id === 'bash' ? 'command failed' : 'unexpected call', b.id === 'bash');
    },
  });
  executor.addTool(block('bash', 'Bash', { command: 'exit 1' }));
  executor.addTool(block('read', 'Read', { file_path: 'irrelevant' }));
  const outputs = [];
  for await (const entry of executor.getRemainingResults()) {
    if (entry.message) outputs.push(entry.message.content[0]);
  }
  assert.deepEqual(invoked, ['bash']);
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].is_error, true);
  assert.equal(outputs[1].is_error, true);
  assert.equal(outputs[1].tool_use_id, 'read');
  assert.match(outputs[1].content, /parallel tool call.*errored/);
});

test('ported scheduler uses synthetic tool results after interruption', async () => {
  const controller = new AbortController();
  const executor = new StreamingToolExecutor({
    getTool: () => ({ isConcurrencySafe: () => false, interruptBehavior: () => 'cancel' }),
    signal: controller.signal,
    execute: async () => result('one', 'not run'),
  });
  controller.abort(new Error('interrupted'));
  executor.addTool(block('one', 'Bash'));
  const outputs = [];
  for await (const update of executor.getRemainingResults()) {
    if (update.message) outputs.push(update.message.content[0]);
  }
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].is_error, true);
  assert.match(outputs[0].content, /User rejected tool use/);
});

test('integrated AgentLoop serializes edited file operations and returns both tool_result blocks', async () => {
  const reg = new ToolRegistry();
  let active = 0;
  let peak = 0;
  const invoked = [];
  for (const name of ['Write', 'Read']) {
    reg.register({
      name, description: name,
      isConcurrencySafe: () => name === 'Read',
      execute: async input => {
        invoked.push(name);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active -= 1;
        return input.value;
      },
    });
  }
  let round = 0;
  const model = { async *stream({ messages }) {
    round += 1;
    if (round === 1) {
      yield { type: 'tool_use', id: 't1', name: 'Write', input: { value: 'changed' } };
      yield { type: 'tool_use', id: 't2', name: 'Read', input: { value: 'observed' } };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } else {
      const results = messages.at(-1).content;
      assert.deepEqual(results.map(r => r.tool_use_id), ['t1', 't2']);
      assert.deepEqual(results.map(r => r.content), ['changed', 'observed']);
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
  const loop = new AgentLoop({ model, tools: reg, permissionPolicy: async () => ({ behavior: 'allow' }) });
  const done = await loop.run({ input: 'Write then read' });
  assert.equal(done.stopReason, 'end_turn');
  assert.deepEqual(invoked, ['Write', 'Read']);
  assert.equal(peak, 1);
});
