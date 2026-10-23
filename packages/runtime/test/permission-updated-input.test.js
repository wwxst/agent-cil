import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

class ScriptedModel {
  constructor(events) { this.events = events; }
  async *stream() {
    for (const event of this.events) yield event;
  }
}

const toolRequest = [
  { type: 'tool_use', id: 'tool-update', name: 'echo', input: { value: 'model input' } },
  { type: 'message_end', stopReason: 'tool_use' },
];

function registry(execute) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'echo',
    description: 'Echo a value.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'],
      additionalProperties: false,
    },
    execute,
  });
  return tools;
}

test('executes the updated input returned by an allow permission policy', async () => {
  let executedInput;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async input => { executedInput = input; return input.value; }),
    permissionPolicy: async () => ({
      behavior: 'allow',
      updatedInput: { value: 'policy-approved input' },
    }),
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  assert.deepEqual(executedInput, { value: 'policy-approved input' });
  assert.equal(result.messages.at(-1).content[0].content, 'policy-approved input');
});

test('revalidates updated input and returns an error tool_result when it violates the schema', async () => {
  let executions = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async () => { executions += 1; return 'should not run'; }),
    permissionPolicy: async () => ({
      behavior: 'allow',
      updatedInput: { value: '', unexpected: true },
    }),
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  const toolResult = result.messages.at(-1).content[0];
  assert.equal(executions, 0);
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /Invalid tool input returned by permission policy/);
  assert.match(toolResult.content, /shorter than minLength/);
  assert.match(toolResult.content, /additional property is not allowed/);
});

test('rechecks policy updates and asks again when approval changes the final input', async () => {
  let executedInput;
  const policyInputs = [];
  const approvalInputs = [];
  const permissionRequiredInputs = [];
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async input => { executedInput = input; return input.value; }),
    permissionPolicy: async ({ input, phase }) => {
      policyInputs.push({ value: input.value, phase });
      return {
        behavior: 'ask',
        reason: 'Confirm the adjusted value.',
        ...(input.value === 'model input' ? { updatedInput: { value: 'prepared for approval' } } : {}),
      };
    },
    approvalHandler: async ({ input }) => {
      approvalInputs.push(input.value);
      if (input.value === 'prepared for approval') {
        return { approved: true, updatedInput: { value: 'user-approved replacement' } };
      }
      return { approved: true };
    },
    maxTurns: 1,
  });
  loop.on('permissionRequired', event => { permissionRequiredInputs.push(event.input.value); });

  const result = await loop.run({ input: 'run the tool' });
  assert.deepEqual(permissionRequiredInputs, ['prepared for approval', 'user-approved replacement']);
  assert.deepEqual(approvalInputs, ['prepared for approval', 'user-approved replacement']);
  assert.deepEqual(policyInputs, [
    { value: 'model input', phase: 'initial' },
    { value: 'prepared for approval', phase: 'recheck' },
    { value: 'user-approved replacement', phase: 'recheck' },
  ]);
  assert.deepEqual(executedInput, { value: 'user-approved replacement' });
  assert.equal(result.messages.at(-1).content[0].content, 'user-approved replacement');
});

test('does not execute an approval handler replacement that fails schema validation', async () => {
  let executions = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async () => { executions += 1; return 'should not run'; }),
    permissionPolicy: async () => ({ behavior: 'ask' }),
    approvalHandler: async () => ({
      approved: true,
      updatedInput: { value: '', extra: true },
    }),
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  const toolResult = result.messages.at(-1).content[0];
  assert.equal(executions, 0);
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /Invalid tool input returned by approval handler/);
});


test('does not execute a policy replacement that the recheck denies', async () => {
  let executions = 0;
  const policyInputs = [];
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async () => { executions += 1; return 'should not run'; }),
    permissionPolicy: async ({ input, phase }) => {
      policyInputs.push({ value: input.value, phase });
      if (input.value === 'model input') {
        return { behavior: 'allow', updatedInput: { value: 'blocked input' } };
      }
      return { behavior: 'deny', reason: 'The replacement is blocked.' };
    },
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  const toolResult = result.messages.at(-1).content[0];
  assert.equal(executions, 0);
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /The replacement is blocked/);
  assert.deepEqual(policyInputs, [
    { value: 'model input', phase: 'initial' },
    { value: 'blocked input', phase: 'recheck' },
  ]);
});

test('does not let a deny decision be overridden by its updatedInput', async () => {
  let executions = 0;
  let policyCalls = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async () => { executions += 1; return 'should not run'; }),
    permissionPolicy: async () => {
      policyCalls += 1;
      return { behavior: 'deny', reason: 'Explicit deny.', updatedInput: { value: 'otherwise safe' } };
    },
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  const toolResult = result.messages.at(-1).content[0];
  assert.equal(executions, 0);
  assert.equal(policyCalls, 1);
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /Explicit deny/);
});

test('rechecks permission after an approval handler replaces the input', async () => {
  let executions = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async () => { executions += 1; return 'should not run'; }),
    permissionPolicy: async ({ input }) => input.value === 'blocked input'
      ? { behavior: 'deny', reason: 'Final input is denied.' }
      : { behavior: 'ask', reason: 'Approval required.' },
    approvalHandler: async () => ({
      approved: true,
      updatedInput: { value: 'blocked input' },
    }),
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  const toolResult = result.messages.at(-1).content[0];
  assert.equal(executions, 0);
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /Final input is denied/);
});

test('fails closed if the permission policy keeps rewriting valid input', async () => {
  let executions = 0;
  let policyCalls = 0;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async () => { executions += 1; return 'should not run'; }),
    permissionPolicy: async ({ input }) => {
      policyCalls += 1;
      return { behavior: 'allow', updatedInput: { value: input.value + 'x' } };
    },
    maxTurns: 1,
  });

  const result = await loop.run({ input: 'run the tool' });
  const toolResult = result.messages.at(-1).content[0];
  assert.equal(executions, 0);
  assert.equal(policyCalls, 9);
  assert.equal(toolResult.is_error, true);
  assert.match(toolResult.content, /repeatedly changed the tool input/);
});
