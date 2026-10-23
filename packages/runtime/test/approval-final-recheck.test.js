import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

function makeLoop({ policy, approve, checkPermissions, execute }) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'Write',
    description: 'Write an approved fixture value.',
    inputSchema: { type: 'object', properties: {
      content: { type: 'string' },
    }, required: ['content'], additionalProperties: false },
    checkPermissions,
    execute,
  });
  let turn = 0;
  const messages = [];
  const loop = new AgentLoop({
    model: { async *stream({ messages: history }) {
      if (turn++ === 0) {
        yield { type: 'tool_use', id: 'approved-write', name: 'Write',
          input: { content: 'original' } };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        const result = history.at(-1).content[0];
        messages.push(result);
        yield { type: 'text_delta', text: 'completed' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } },
    tools,
    permissionPolicy: policy,
    approvalHandler: approve,
  });
  return { loop, messages };
}

test('approved Write is blocked if global policy revokes access during approval', async () => {
  let authorized = true;
  let writes = 0;
  const phases = [];
  const { loop, messages } = makeLoop({
    policy: async ({ phase }) => {
      phases.push(phase);
      return { behavior: authorized ? 'ask' : 'deny', reason: 'Ask before writing' };
    },
    approve: async () => {
      authorized = false;
      return { approved: true };
    },
    execute: async () => { writes++; return { written: true }; },
  });
  const result = await loop.run({ input: 'Write the fixture' });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(writes, 0);
  assert.deepEqual(phases, ['initial', 'post-approval']);
  assert.equal(messages[0].is_error, true);
  assert.match(messages[0].content, /permission changed during approval/);
});

test('approved Write is blocked if tool-specific check revokes access after approval', async () => {
  let allow = true, writes = 0;
  const { loop, messages } = makeLoop({
    policy: async () => ({ behavior: 'ask', reason: 'Write requires approval' }),
    checkPermissions: async () => {
      if (!allow) return { behavior: 'deny', reason: 'Workspace now read-only' };
      return { behavior: 'passthrough' };
    },
    approve: async () => { allow = false; return { approved: true }; },
    execute: async () => { writes++; return 'not allowed'; },
  });
  await loop.run({ input: 'Write' });
  assert.equal(writes, 0);
  assert.equal(messages[0].is_error, true);
  assert.match(messages[0].content, /permission changed during approval/);
});

test('approval cannot authorize an input rewrite returned by the late policy', async () => {
  let policyCalls = 0, writes = 0;
  const { loop, messages } = makeLoop({
    policy: async () => {
      policyCalls++;
      return policyCalls === 1
        ? { behavior: 'ask', reason: 'Confirm file write' }
        : { behavior: 'ask', reason: 'Confirm file write',
          updatedInput: { content: 'different' } };
    },
    approve: async () => true,
    execute: async () => { writes++; return 'not allowed'; },
  });
  await loop.run({ input: 'Write' });
  assert.equal(writes, 0);
  assert.equal(messages[0].is_error, true);
  assert.match(messages[0].content, /permission changed during approval/);
});

test('unchanged ask approval continues to execute exactly once', async () => {
  let writes = 0, approvals = 0;
  const phases = [];
  const { loop, messages } = makeLoop({
    policy: async ({ phase }) => {
      phases.push(phase);
      return { behavior: 'ask', reason: 'Confirm file write' };
    },
    approve: async () => { approvals++; return { approved: true }; },
    execute: async ({ content }) => {
      writes++;
      assert.equal(content, 'original');
      return { written: true };
    },
  });
  await loop.run({ input: 'Write' });
  assert.deepEqual(phases, ['initial', 'post-approval']);
  assert.equal(approvals, 1);
  assert.equal(writes, 1);
  assert.equal(messages[0].is_error, undefined);
});

test('new approval reason requires new consent and blocks stale approval', async () => {
  let calls = 0, writes = 0;
  const { loop, messages } = makeLoop({
    policy: async () => ({ behavior: 'ask', reason: ++calls === 1
      ? 'Run harmless tool' : 'Potentially dangerous write detected' }),
    approve: async () => ({ approved: true }),
    execute: async () => { writes++; return 'unexpected'; },
  });
  await loop.run({ input: 'Write' });
  assert.equal(writes, 0);
  assert.equal(messages[0].is_error, true);
  assert.match(messages[0].content, /permission changed during approval/);
});
