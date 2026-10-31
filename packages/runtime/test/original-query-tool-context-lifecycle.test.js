import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('original query.ts newContext survives a second model round and reaches native Tool.call and permission checks', {
  timeout: 20000,
}, async () => {
  const tools = new ToolRegistry();
  const policyObservations = [];
  const callObservations = [];
  let providerRounds = 0, modifierCalls = 0, initialSignal;
  tools.register({
    name: 'StartSession', description: 'Original ToolUseContext state producer',
    call: async (_input, context) => {
      initialSignal = context.abortController.signal;
      callObservations.push({ tool: 'StartSession', state: context.sessionMark });
      return {
        data: 'started',
        contextModifier: previous => {
          modifierCalls++;
          assert.equal(previous.sessionMark, undefined);
          return { ...previous, sessionMark: 'from-completed-model-round' };
        },
      };
    },
    mapToolResultToToolResultBlockParam: (data, id) =>
      ({ type: 'tool_result', tool_use_id: id, content: data }),
  });
  tools.register({
    name: 'ReadSession', description: 'Original ToolUseContext state consumer',
    call: async (_input, context) => {
      callObservations.push({ tool: 'ReadSession', state: context.sessionMark });
      assert.equal(context.sessionMark, 'from-completed-model-round');
      assert.notStrictEqual(context.abortController.signal, initialSignal,
        'each model round must obtain a fresh abort controller');
      return { data: 'read state' };
    },
    mapToolResultToToolResultBlockParam: (data, id) =>
      ({ type: 'tool_result', tool_use_id: id, content: data }),
  });
  const loop = new AgentLoop({
    tools,
    maxTurns: 4,
    permissionPolicy: async ({ name, phase, toolUseContext }) => {
      if (phase === 'initial') {
        policyObservations.push({ name, state: toolUseContext?.sessionMark });
      }
      return { behavior: name !== 'ReadSession' ||
        toolUseContext?.sessionMark === 'from-completed-model-round'
        ? 'allow' : 'deny', reason: 'ToolUseContext was lost between query rounds' };
    },
    model: { async *stream({ messages }) {
      providerRounds++;
      if (providerRounds === 1) {
        yield { type: 'tool_use', id: 'session-create',
          name: 'StartSession', input: {} };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else if (providerRounds === 2) {
        assert.equal(messages.at(-1).content[0].content, 'started');
        yield { type: 'tool_use', id: 'session-consume',
          name: 'ReadSession', input: {} };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        assert.equal(providerRounds, 3);
        assert.deepEqual(messages.at(-1).content,
          [{ type: 'tool_result', tool_use_id: 'session-consume', content: 'read state' }]);
        yield { type: 'text_delta', text: 'state survived both turns' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } },
  });
  const checkpoints = [];
  loop.on('turnFinished', event => {
    if (event.committedMessages) checkpoints.push(event.committedMessages);
  });
  const result = await loop.run({ input: 'start and then read session state' });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(providerRounds, 3);
  assert.equal(modifierCalls, 1);
  assert.deepEqual(policyObservations, [
    { name: 'StartSession', state: undefined },
    { name: 'ReadSession', state: 'from-completed-model-round' },
  ]);
  assert.deepEqual(callObservations, [
    { tool: 'StartSession', state: undefined },
    { tool: 'ReadSession', state: 'from-completed-model-round' },
  ]);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].at(-1).content[0].tool_use_id, 'session-create');
  assert.equal(checkpoints[1].at(-1).content[0].tool_use_id, 'session-consume');
  assert.deepEqual(checkpoints[1], result.messages.slice(0, 5));
});

test('original Query ToolUseContext never leaks across independent AgentLoop.run sessions', {
  timeout: 20000,
}, async () => {
  const tools = new ToolRegistry();
  let seen = [];
  tools.register({
    name: 'SetState', description: 'Per-run tool context producer',
    call: async () => ({
      data: 'okay',
      contextModifier: original => ({ ...original, crossRunMarker: 'must-not-leak' }),
    }),
    mapToolResultToToolResultBlockParam: (data, id) =>
      ({ type: 'tool_result', tool_use_id: id, content: data }),
  });
  const loop = new AgentLoop({
    tools, maxTurns: 2,
    permissionPolicy: async ({ phase, toolUseContext }) => {
      if (phase === 'initial') seen.push(toolUseContext?.crossRunMarker);
      return { behavior: 'allow' };
    },
    model: { async *stream({ messages }) {
      const hasTool = messages.some(m => m.role === 'assistant' &&
        m.content?.some(b => b.type === 'tool_use'));
      if (!hasTool) {
        yield { type: 'tool_use', id: 'independent-'+seen.length,
          name: 'SetState', input: {} };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } },
  });
  assert.equal((await loop.run({ input: 'first independent run' })).stopReason, 'end_turn');
  assert.equal((await loop.run({ input: 'second independent run' })).stopReason, 'end_turn');
  assert.deepEqual(seen, [undefined, undefined],
    'a new top-level session must not inherit a previous run private ToolUseContext');
});
