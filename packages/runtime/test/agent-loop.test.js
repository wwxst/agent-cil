import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop, ModelProtocolError } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

class ScriptedModel {
  constructor(scripts) { this.scripts = [...scripts]; this.calls = []; }
  async *stream(context) {
    this.calls.push(context);
    const script = this.scripts.shift();
    if (typeof script === 'function') { yield* script(context); return; }
    for (const event of script ?? []) yield event;
  }
}

const textEnd = text => [
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn' },
];
const toolEnd = (id, name, input) => [
  { type: 'tool_use', id, name, input },
  { type: 'message_end', stopReason: 'tool_use' },
];

function makeRegistry(execute = async input => input) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Return the supplied value.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
    execute,
  });
  return registry;
}

test('runs two model rounds and feeds tool_result back before the final answer', async () => {
  const model = new ScriptedModel([
    [
      { type: 'text_delta', text: 'I will check: ' },
      { type: 'tool_use', id: 'tool-1', name: 'echo', input: { value: 'hello' } },
      { type: 'message_end', stopReason: 'tool_use' },
    ],
    context => {
      const last = context.messages.at(-1);
      assert.equal(last.role, 'user');
      assert.equal(last.content[0].type, 'tool_result');
      assert.equal(last.content[0].tool_use_id, 'tool-1');
      assert.equal(last.content[0].content, '{"value":"hello"}');
      assert.equal(context.tools[0].name, 'echo');
      return textEnd('The tool returned hello.');
    },
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async input => ({ value: input.value })),
    permissionPolicy: async ({ tool }) => {
      assert.equal(Object.hasOwn(tool, 'execute'), false, 'policy receives metadata, not an executable tool');
      return { behavior: 'allow', reason: 'test policy' };
    },
  });
  const deltas = [];
  loop.on('textDelta', event => deltas.push(event.text));
  const result = await loop.run({ input: 'Please check hello.' });

  assert.equal(result.turns, 2);
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(result.messages.length, 4);
  assert.equal(result.finalMessage.content[0].text, 'The tool returned hello.');
  assert.deepEqual(deltas, ['I will check: ', 'The tool returned hello.']);
  assert.equal(loop.active, false);
});

test('defaults to deny and never executes a tool without an explicit allow decision', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    toolEnd('tool-denied', 'echo', { value: 'secret' }),
    context => {
      assert.equal(context.messages.at(-1).content[0].is_error, true);
      assert.match(context.messages.at(-1).content[0].content, /denied/);
      return textEnd('The operation was not authorized.');
    },
  ]);
  const loop = new AgentLoop({ model, tools: makeRegistry(async input => { executions += 1; return input; }) });
  const result = await loop.run({ input: 'Try the tool.' });
  assert.equal(executions, 0);
  assert.equal(result.turns, 2);
  assert.match(result.messages[2].content[0].content, /No permission policy/);
});

test('ask decisions require explicit approval before execution', async () => {
  let executions = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel([toolEnd('tool-ask', 'echo', { value: 'approved?' }), textEnd('Done.')]),
    tools: makeRegistry(async input => { executions += 1; return input.value; }),
    permissionPolicy: async () => ({ behavior: 'ask', reason: 'Potentially sensitive action.' }),
    approvalHandler: async ({ toolUseId }) => {
      assert.equal(toolUseId, 'tool-ask');
      return { approved: true };
    },
  });
  const result = await loop.run({ input: 'Ask before using the tool.' });
  assert.equal(executions, 1);
  assert.equal(result.messages[2].content[0].content, 'approved?');
});

test('an ask decision without an approval handler fails closed', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    toolEnd('tool-no-approval', 'echo', { value: 'no' }),
    context => {
      assert.equal(context.messages.at(-1).content[0].is_error, true);
      assert.match(context.messages.at(-1).content[0].content, /No approval handler/);
      return textEnd('Stopped.');
    },
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async input => { executions += 1; return input; }),
    permissionPolicy: async () => ({ behavior: 'ask' }),
  });
  await loop.run({ input: 'Use a tool.' });
  assert.equal(executions, 0);
});

test('invalid input is rejected before permission evaluation or tool execution', async () => {
  let policyCalls = 0;
  let executions = 0;
  const model = new ScriptedModel([
    toolEnd('tool-invalid', 'echo', { value: '', extra: true }),
    context => {
      const result = context.messages.at(-1).content[0];
      assert.equal(result.is_error, true);
      assert.match(result.content, /Invalid tool input/);
      return textEnd('Invalid arguments were rejected.');
    },
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async input => { executions += 1; return input; }),
    permissionPolicy: async () => { policyCalls += 1; return { behavior: 'allow' }; },
  });
  await loop.run({ input: 'Use invalid arguments.' });
  assert.equal(policyCalls, 0);
  assert.equal(executions, 0);
});

test('unknown tools become error tool_result blocks and do not crash the loop', async () => {
  const model = new ScriptedModel([
    toolEnd('tool-missing', 'missing_tool', {}),
    context => {
      assert.equal(context.messages.at(-1).content[0].tool_use_id, 'tool-missing');
      assert.equal(context.messages.at(-1).content[0].is_error, true);
      return textEnd('That tool is unavailable.');
    },
  ]);
  const result = await new AgentLoop({ model }).run({ input: 'Call a missing tool.' });
  assert.equal(result.turns, 2);
});

test('stops at maxTurns after returning the final tool result to history', async () => {
  let executions = 0;
  const model = new ScriptedModel([toolEnd('tool-max', 'echo', { value: 'last' })]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async input => { executions += 1; return input.value; }),
    permissionPolicy: async () => ({ behavior: 'allow' }),
    maxTurns: 1,
  });
  const result = await loop.run({ input: 'Run one round.' });
  assert.equal(result.stopReason, 'max_turns');
  assert.equal(result.turns, 1);
  assert.equal(executions, 1);
  assert.equal(result.messages.at(-1).content[0].tool_use_id, 'tool-max');
});

test('propagates cancellation and releases the loop for a later run', async () => {
  const controller = new AbortController();
  const model = new ScriptedModel([
    async function* () {
      controller.abort();
      yield { type: 'text_delta', text: 'too late' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    },
    textEnd('recovered'),
  ]);
  const loop = new AgentLoop({ model });
  await assert.rejects(loop.run({ input: 'cancel', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(loop.active, false);
  const result = await loop.run({ input: 'next run' });
  assert.equal(result.finalMessage.content[0].text, 'recovered');
});

test('rejects model streams that omit message_end', async () => {
  const model = new ScriptedModel([[{ type: 'text_delta', text: 'incomplete' }]]);
  await assert.rejects(new AgentLoop({ model }).run({ input: 'hello' }), ModelProtocolError);
});

test('rejects duplicate tool-use IDs across model rounds', async () => {
  const model = new ScriptedModel([
    toolEnd('reused-id', 'echo', { value: 'first' }),
    toolEnd('reused-id', 'echo', { value: 'second' }),
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  await assert.rejects(loop.run({ input: 'reuse an ID' }), /Duplicate tool_use id/);
});

test('permission policy errors become denied tool results', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    toolEnd('tool-policy-error', 'echo', { value: 'x' }),
    context => {
      assert.equal(context.messages.at(-1).content[0].is_error, true);
      assert.match(context.messages.at(-1).content[0].content, /Permission policy failed/);
      return textEnd('Policy error handled.');
    },
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async input => { executions += 1; return input; }),
    permissionPolicy: async () => { throw new Error('policy unavailable'); },
  });
  await loop.run({ input: 'Try action.' });
  assert.equal(executions, 0);
});


test('approval rejection prevents tool execution and is returned to the model', async () => {
  let executions = 0;
  const model = new ScriptedModel([
    toolEnd('tool-rejected', 'echo', { value: 'no' }),
    context => {
      const result = context.messages.at(-1).content[0];
      assert.equal(result.is_error, true);
      assert.match(result.content, /Approval declined/);
      return textEnd('Approval was declined.');
    },
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async input => { executions += 1; return input; }),
    permissionPolicy: async () => ({ behavior: 'ask' }),
    approvalHandler: async () => ({ approved: false, reason: 'Approval declined by user.' }),
  });
  await loop.run({ input: 'Ask before using a tool.' });
  assert.equal(executions, 0);
});

test('tool execution errors become error tool_result blocks and allow recovery', async () => {
  const model = new ScriptedModel([
    toolEnd('tool-exception', 'echo', { value: 'break' }),
    context => {
      const result = context.messages.at(-1).content[0];
      assert.equal(result.tool_use_id, 'tool-exception');
      assert.equal(result.is_error, true);
      assert.match(result.content, /Tool execution failed: simulated tool failure/);
      return textEnd('Recovered from the tool error.');
    },
  ]);
  const loop = new AgentLoop({
    model,
    tools: makeRegistry(async () => { throw new Error('simulated tool failure'); }),
    permissionPolicy: async () => ({ behavior: 'allow' }),
  });
  const result = await loop.run({ input: 'Call a failing tool.' });
  assert.equal(result.turns, 2);
  assert.equal(result.finalMessage.content[0].text, 'Recovered from the tool error.');
});


test('propagates cancellation when an approval handler aborts and rejects', async () => {
  const controller = new AbortController();
  let executions = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel([toolEnd('tool-cancel-approval', 'echo', { value: 'wait' })]),
    tools: makeRegistry(async input => { executions += 1; return input; }),
    permissionPolicy: async () => ({ behavior: 'ask' }),
    approvalHandler: async ({ signal }) => {
      controller.abort();
      throw signal.reason;
    },
    maxTurns: 1,
  });
  await assert.rejects(
    loop.run({ input: 'Cancel during approval.', signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(executions, 0);
  assert.equal(loop.active, false);
});
