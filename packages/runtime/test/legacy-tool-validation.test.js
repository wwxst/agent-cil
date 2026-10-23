import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { runToolUse } from '../src/legacy-tools/tool-execution.js';

const inputSchema = {
  type: 'object',
  properties: { value: { type: 'string', minLength: 1 } },
  required: ['value'],
  additionalProperties: false,
};
const toolEnd = input => [
  { type: 'tool_use', id: 'ported-validation', name: 'Validate', input },
  { type: 'message_end', stopReason: 'tool_use' },
];
const resultModel = (input, checkResult) => {
  let round = 0;
  return { async *stream({ messages }) {
    if (round++ === 0) {
      yield* toolEnd(input);
    } else {
      checkResult(messages.at(-1).content[0]);
      yield { type: 'text_delta', text: 'handled' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    }
  } };
};

test('legacy checkPermissionsAndCallTool validates schema before tool-specific values or permission', async () => {
  let valueChecks = 0;
  let permissionCalls = 0;
  let approvalCalls = 0;
  let executeCalls = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'Validate', description: 'Validate input.', inputSchema,
    validateInput: async () => { valueChecks++; return { result: true }; },
    execute: async () => { executeCalls++; return 'not allowed'; },
  });
  let validationEvents = 0;
  const loop = new AgentLoop({
    model: resultModel({ value: '', extra: 3 }, result => {
      assert.equal(result.is_error, true);
      assert.match(result.content, /InputValidationError: Invalid tool input/);
    }),
    tools,
    permissionPolicy: async () => { permissionCalls++; return { behavior: 'allow' }; },
    approvalHandler: async () => { approvalCalls++; return true; },
  });
  loop.on('toolCallFinished', event => {
    if (event.inputValidationFailed) validationEvents++;
  });
  const done = await loop.run({ input: 'test invalid schema' });
  assert.equal(done.stopReason, 'end_turn');
  assert.equal(valueChecks, 0);
  assert.equal(permissionCalls, 0);
  assert.equal(approvalCalls, 0);
  assert.equal(executeCalls, 0);
  assert.equal(validationEvents, 1);
});

test('legacy tool.validateInput result=false is an error before approval with original message', async () => {
  let permissionCalls = 0;
  let executeCalls = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: 'Validate', description: 'Validate input.', inputSchema,
    validateInput: async () => ({ result: false, message: 'No such source file.', errorCode: 42 }),
    execute: async () => { executeCalls++; return 'not allowed'; },
  });
  const loop = new AgentLoop({
    model: resultModel({ value: 'missing.txt' }, result => {
      assert.equal(result.is_error, true);
      assert.match(result.content, /No such source file/);
    }),
    tools,
    permissionPolicy: async () => { permissionCalls++; return { behavior: 'ask' }; },
    approvalHandler: async () => { throw new Error('must not ask'); },
  });
  await loop.run({ input: 'test invalid value' });
  assert.equal(permissionCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(await tools.validateInput('Validate', { value: 'missing.txt' }), ['No such source file.']);
});

test('valid input is checked exactly once before permission; then executes unchanged', async () => {
  let checks = 0;
  let policyCalls = 0;
  const seen = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'Validate', description: 'Validate input.', inputSchema,
    validateInput: async value => {
      checks++;
      assert.deepEqual(value, { value: 'allowed' });
      return { result: true };
    },
    execute: async value => { seen.push(value); return value.value; },
  });
  const loop = new AgentLoop({
    model: resultModel({ value: 'allowed' }, result => {
      assert.equal(result.content, 'allowed');
      assert.equal(result.is_error, undefined);
    }),
    tools,
    permissionPolicy: async () => { policyCalls++; return { behavior: 'allow' }; },
  });
  await loop.run({ input: 'test good input' });
  assert.equal(checks, 1, 'must not validate both in runToolUse and AgentLoop');
  assert.equal(policyCalls, 1);
  assert.deepEqual(seen, [{ value: 'allowed' }]);
});

test('permission updatedInput still revalidates and reauthorizes after initial legacy validation', async () => {
  const checks = [];
  const decisions = [];
  const executed = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'Validate', description: 'Validate input.', inputSchema,
    validateInput: async value => {
      checks.push(value.value);
      return { result: true };
    },
    execute: async value => { executed.push(value.value); return value.value; },
  });
  const loop = new AgentLoop({
    model: resultModel({ value: 'start' }, result => {
      assert.equal(result.content, 'redirected');
      assert.equal(result.is_error, undefined);
    }),
    tools,
    permissionPolicy: async ({ input, phase }) => {
      decisions.push([phase, input.value]);
      return input.value === 'start'
        ? { behavior: 'allow', updatedInput: { value: 'redirected' } }
        : { behavior: 'allow' };
    },
  });
  await loop.run({ input: 'test rewrite' });
  assert.deepEqual(checks, ['start', 'redirected']);
  assert.deepEqual(decisions, [['initial', 'start'], ['recheck', 'redirected']]);
  assert.deepEqual(executed, ['redirected']);
});

test('direct legacy runToolUse returns value-validator failure before adapter call', async () => {
  let executed = 0;
  const tool = {
    name: 'Validate', inputSchema,
    validateInput: async () => ({ result: false, message: 'Invalid target.' }),
  };
  const updates = [];
  for await (const update of runToolUse(
    { type: 'tool_use', id: 'direct', name: 'Validate', input: { value: 'bad' } },
    { role: 'assistant' },
    async () => { executed++; },
    { getTool: () => tool },
  )) updates.push(update);
  assert.equal(executed, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].message.content[0].is_error, true);
  assert.match(updates[0].message.content[0].content, /Invalid target/);
});

test('an asynchronously replaced registry tool cannot execute without matching validation', async () => {
  const tools = new ToolRegistry();
  let beganValidation;
  const validating = new Promise(resolve => { beganValidation = resolve; });
  let completeValidation;
  const canFinish = new Promise(resolve => { completeValidation = resolve; });
  let oldExecutions = 0;
  let replacementExecutions = 0;
  const unregisterOld = tools.register({
    name: 'Validate', description: 'Old validator and tool.', inputSchema,
    validateInput: async () => {
      beganValidation();
      await canFinish;
      return true;
    },
    execute: async () => { oldExecutions++; return 'old'; },
  });
  const loop = new AgentLoop({
    model: { async *stream() {
      yield* toolEnd({ value: 'old input' });
    } },
    tools,
    permissionPolicy: async () => ({ behavior: 'allow' }),
    maxTurns: 1,
  });
  const running = loop.run({ input: 'replace tool while validating' });
  await validating;
  unregisterOld();
  tools.register({
    name: 'Validate', description: 'New validator and tool.',
    inputSchema: {
      type: 'object', properties: { safe: { type: 'boolean' } },
      required: ['safe'], additionalProperties: false,
    },
    execute: async () => { replacementExecutions++; return 'unsafe'; },
  });
  completeValidation();
  const answer = await running;
  const last = answer.messages.at(-1).content[0];
  assert.equal(last.is_error, true);
  assert.match(last.content, /Tool definition changed after input validation/);
  assert.equal(oldExecutions, 0);
  assert.equal(replacementExecutions, 0);
});

test('permission updatedInput validator receives the original legacy context and signal', async () => {
  const contexts = [];
  const values = [];
  const tools = new ToolRegistry();
  tools.register({
    name: 'Validate', description: 'Context-aware validator.', inputSchema,
    validateInput: async (value, context) => {
      assert.ok(context?.signal, 'value validator must receive an execution AbortSignal');
      assert.equal(typeof context.getTool, 'function');
      contexts.push(context);
      values.push(value.value);
      return { result: true };
    },
    execute: async value => value.value,
  });
  const loop = new AgentLoop({
    model: resultModel({ value: 'initial' }, result => {
      assert.equal(result.content, 'rewritten');
      assert.equal(result.is_error, undefined);
    }),
    tools,
    permissionPolicy: async ({ input }) => input.value === 'initial'
      ? { behavior: 'allow', updatedInput: { value: 'rewritten' } }
      : { behavior: 'allow' },
  });
  await loop.run({ input: 'rewrite with validator context' });
  assert.deepEqual(values, ['initial', 'rewritten']);
  assert.equal(contexts.length, 2);
  assert.strictEqual(contexts[0], contexts[1]);
});
