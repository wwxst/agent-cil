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

test('passes policy-updated input to approval and executes the approved replacement', async () => {
  let executedInput;
  let permissionRequiredInput;
  const loop = new AgentLoop({
    model: new ScriptedModel(toolRequest),
    tools: registry(async input => { executedInput = input; return input.value; }),
    permissionPolicy: async () => ({
      behavior: 'ask',
      reason: 'Confirm the adjusted value.',
      updatedInput: { value: 'prepared for approval' },
    }),
    approvalHandler: async ({ input }) => {
      assert.deepEqual(input, { value: 'prepared for approval' });
      return { approved: true, updatedInput: { value: 'user-approved replacement' } };
    },
    maxTurns: 1,
  });
  loop.on('permissionRequired', event => { permissionRequiredInput = event.input; });

  const result = await loop.run({ input: 'run the tool' });
  assert.deepEqual(permissionRequiredInput, { value: 'prepared for approval' });
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
