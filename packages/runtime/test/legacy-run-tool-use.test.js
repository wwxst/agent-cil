import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Stream } from '../src/legacy-tools/stream.js';
import {
  runToolUse,
  streamedCheckPermissionsAndCallTool,
} from '../src/legacy-tools/tool-execution.js';

const toolUse = (id = 'old-1', name = 'Read') =>
  ({ type: 'tool_use', id, name, input: { file_path: 'test.txt' } });
const tool = { name: 'Read', execute: async () => 'ok' };
const context = (overrides = {}) => ({
  getTool: name => name === 'Read' ? tool : undefined,
  ...overrides,
});
const readAll = async generator => {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
};

test('ported Stream preserves 2.1.88 queued event order, single iteration and return hook', async () => {
  let returned = 0;
  const stream = new Stream(() => { returned += 1; });
  stream.enqueue('first');
  stream.enqueue('second');
  stream.done();
  assert.deepEqual(await readAll(stream), ['first', 'second']);
  assert.throws(() => stream[Symbol.asyncIterator](), /only be iterated once/);
  const live = new Stream(() => { returned += 1; });
  const iterator = live[Symbol.asyncIterator]();
  const pending = iterator.next();
  live.enqueue('ready');
  assert.deepEqual(await pending, { done: false, value: 'ready' });
  assert.deepEqual(await live.return(), { done: true, value: undefined });
  assert.equal(returned, 1);
});

test('ported Stream propagates failure to a waiting reader', async () => {
  const stream = new Stream();
  const pending = stream.next();
  const error = new Error('legacy worker exploded');
  stream.error(error);
  await assert.rejects(pending, error);
});

test('ported runToolUse returns original unknown-tool error without running adapter', async () => {
  let executions = 0;
  const updates = await readAll(runToolUse(
    toolUse('missing-1', 'Missing'),
    { role: 'assistant' },
    async () => { executions += 1; },
    context(),
  ));
  assert.equal(executions, 0);
  assert.equal(updates.length, 1);
  const block = updates[0].message.content[0];
  assert.equal(block.tool_use_id, 'missing-1');
  assert.equal(block.is_error, true);
  assert.match(block.content, /No such tool available: Missing/);
});

test('ported streaming permission bridge delivers progress before terminal tool_result', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const received = [];
  const iterator = runToolUse(toolUse(), { role: 'assistant' }, async (block, { onToolProgress }) => {
    onToolProgress({ stage: 'read-started' });
    await waiting;
    return { type: 'tool_result', tool_use_id: block.id, content: 'contents' };
  }, context());

  const first = iterator.next();
  assert.deepEqual(await first, { done: false, value: { progress: { stage: 'read-started' } } });
  release();
  for await (const update of iterator) received.push(update);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].message, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'old-1', content: 'contents' },
  ] });
});

test('ported runToolUse converts worker exceptions and invalid results to tool errors', async () => {
  for (const execute of [
    async () => { throw new Error('disk offline'); },
    async () => ({ type: 'tool_result', tool_use_id: 'wrong-id', content: 'wrong' }),
  ]) {
    const events = await readAll(runToolUse(toolUse(), {}, execute, context()));
    assert.equal(events.length, 1);
    const result = events[0].message.content[0];
    assert.equal(result.is_error, true);
    assert.equal(result.tool_use_id, 'old-1');
    assert.match(result.content, /Error calling tool \(Read\):/);
  }
});

test('ported runToolUse surfaces pre-cancelled requests as model-visible cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const outputs = await readAll(runToolUse(toolUse(), {}, async () => {
    called = true;
  }, context({ signal: controller.signal })));
  assert.equal(called, false);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].message.content[0].is_error, true);
  assert.match(outputs[0].message.content[0].content, /User rejected tool use/);
});

test('streamedCheckPermissionsAndCallTool supports direct adapter stream use', async () => {
  const outputs = await readAll(streamedCheckPermissionsAndCallTool(
    tool,
    toolUse('direct'),
    {},
    async () => ({ type: 'tool_result', tool_use_id: 'direct', content: 'ok' }),
    context(),
  ));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].message.content[0].content, 'ok');
});
