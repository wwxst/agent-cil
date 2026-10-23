import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from '../../runtime/src/agent-loop.js';
import { createBuiltinTools } from '../src/index.js';

async function until(check, timeout = 5000) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > timeout) throw new Error('timeout waiting for tool');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('real Edit succeeds, Bash is cancelled, and Query checkpoints all tool IDs for continuation', {
  timeout: 18000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-interrupted-batch-'));
  const ac = new AbortController();
  try {
    await writeFile(join(workspace, 'target.txt'), 'before\n');
    await writeFile(join(workspace, 'worker.cjs'), [
      "const fs=require('node:fs');",
      "fs.writeFileSync('started.txt','started');",
      "setTimeout(()=>fs.writeFileSync('late.txt','bad'),6000);",
    ].join('\n'));
    const tools = await createBuiltinTools({ workspace });
    let streamCount = 0;
    const model = { async *stream({ messages }) {
      streamCount++;
      if (streamCount === 1) {
        yield { type: 'tool_use', id: 'edit-1', name: 'Edit',
          input: { file_path: 'target.txt', old_string: 'before', new_string: 'after' } };
        yield { type: 'tool_use', id: 'bash-2', name: 'Bash',
          input: { command: 'node worker.cjs', timeout_ms: 12000 } };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        assert.deepEqual(messages.map(m => m.role),
          ['user', 'assistant', 'user', 'user']);
        const results = messages[2].content;
        assert.equal(results.length, 2);
        assert.deepEqual(results.map(x => x.tool_use_id), ['edit-1', 'bash-2']);
        assert.equal(JSON.parse(results[0].content).edited, true);
        assert.equal(results[1].is_error, true);
        yield { type: 'text_delta', text: 'Checked the prior Edit; will not replay.' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } };
    const loop = new AgentLoop({
      model, tools, permissionPolicy: async () => ({ behavior: 'allow' }),
    });
    const completed = [], checkpoints = [];
    loop.on('toolCallFinished', x => completed.push(x));
    loop.on('turnFinished', x => { if (x.committedMessages) checkpoints.push(x); });
    const pending = loop.run({ input: 'edit and bash', signal: ac.signal });
    await until(async () => (await readFile(join(workspace, 'target.txt'), 'utf8')) === 'after\n');
    await until(async () => {
      try { return (await readFile(join(workspace, 'started.txt'), 'utf8')) === 'started'; }
      catch { return false; }
    });
    ac.abort(new Error('Interrupted by user'));
    await assert.rejects(pending, /Interrupted by user/);
    assert.equal(checkpoints.length, 1, 'partial batch must produce a resumable checkpoint');
    assert.equal(checkpoints[0].interrupted, true);
    assert.equal(checkpoints[0].committedMessages.length, 3);
    assert.equal(completed.some(x => x.toolName === 'Edit' && !x.isError), true);
    const results = checkpoints[0].committedMessages[2].content;
    assert.equal(JSON.parse(results[0].content).edited, true);
    assert.equal(results[1].is_error, true);
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'after\n');
    const resumed = await loop.run({
      messages: checkpoints[0].committedMessages, input: 'continue',
    });
    assert.equal(resumed.finalMessage.content[0].text,
      'Checked the prior Edit; will not replay.');
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'after\n');
    assert.equal(streamCount, 2);
  } finally {
    ac.abort();
    await rm(workspace, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
  }
});

test('queued tool never starts after cancellation; creates one not-started result', async () => {
  const controller = new AbortController();
  let first, firstResolve, runs = 0;
  first = new Promise(resolve => { firstResolve = resolve; });
  const { StreamingToolExecutor } = await import('../../runtime/src/legacy-tools/streaming-tool-executor.js');
  const executor = new StreamingToolExecutor({
    signal: controller.signal,
    getTool: name => name === 'Write' ? { name, isConcurrencySafe: () => false } : null,
    execute: async block => {
      runs++;
      if (block.id === 'running') {
        await first;
        return { type: 'tool_result', tool_use_id: block.id, content: 'finished' };
      }
      throw new Error('queued write must never execute');
    },
  });
  executor.addTool({ type: 'tool_use', id: 'running', name: 'Write', input: {} });
  executor.addTool({ type: 'tool_use', id: 'queued', name: 'Write', input: {} });
  controller.abort(new Error('Interrupted'));
  firstResolve();
  const outcome = await executor.takeInterruptedResults();
  assert.equal(runs, 1);
  assert.deepEqual(outcome.map(x => x.tool_use_id), ['running', 'queued']);
  assert.equal(outcome[1].is_error, true);
  assert.match(outcome[1].content, /not started/);
});


test('abort during Edit permission wait checkpoints a never-started result without editing', {
  timeout: 10000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-pending-approval-'));
  const controller = new AbortController();
  let releasePermission;
  const pendingApproval = new Promise(resolve => { releasePermission = resolve; });
  let signalApprovalReached;
  const approvalReached = new Promise(resolve => { signalApprovalReached = resolve; });
  try {
    await writeFile(join(workspace, 'target.txt'), 'unchanged\n');
    const tools = await createBuiltinTools({ workspace });
    const model = { async *stream() {
      yield {
        type: 'tool_use', id: 'permission-pending', name: 'Edit',
        input: { file_path: 'target.txt', old_string: 'unchanged', new_string: 'edited' },
      };
      yield { type: 'message_end', stopReason: 'tool_use' };
    } };
    const checkpoints = [], started = [];
    const loop = new AgentLoop({
      model, tools,
      permissionPolicy: async () => {
        signalApprovalReached();
        await pendingApproval;
        return { behavior: 'allow' };
      },
    });
    loop.on('turnFinished', event => {
      if (event.committedMessages) checkpoints.push(event);
    });
    loop.on('toolCallStarted', event => started.push(event));
    const request = loop.run({ input: 'edit', signal: controller.signal });
    await approvalReached;
    controller.abort(new Error('cancel pending permission'));
    releasePermission();
    await assert.rejects(request, /cancel pending permission/);
    assert.equal(started.length, 0);
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'unchanged\n');
    assert.equal(checkpoints.length, 1);
    const result = checkpoints[0].committedMessages.at(-1).content[0];
    assert.equal(result.tool_use_id, 'permission-pending');
    assert.equal(result.is_error, true);
    assert.match(result.content, /not started/);
  } finally {
    controller.abort();
    releasePermission?.();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
