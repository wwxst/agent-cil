import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { resolveToolSpecificPermission } from '../src/legacy-permissions/tool-specific-permission.js';

const permitted = (tool, input, behavior) =>
  resolveToolSpecificPermission({ tool, input, baseDecision: { behavior } });

function makeLoop({ input = { value: 'before' }, permissionPolicy, checkPermissions, approvalHandler,
  validateInput, execute, observeResult }) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'Scoped', description: 'A tool with input-specific permissions.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', minLength: 1 } },
      required: ['value'], additionalProperties: false,
    },
    checkPermissions, validateInput,
    execute: execute ?? (async data => data.value),
  });
  let turn = 0;
  const model = {
    async *stream({ messages }) {
      if (++turn === 1) {
        yield { type: 'tool_use', id: 'scoped-id', name: 'Scoped', input };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        const toolResult = messages.at(-1).content[0];
        observeResult?.(toolResult);
        yield { type: 'text_delta', text: 'complete' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    },
  };
  return new AgentLoop({ model, tools: registry, permissionPolicy, approvalHandler });
}

test('2.1.88 tool-specific permission stage preserves global deny and ask boundaries', async () => {
  let invoked = 0;
  const tool = {
    name: 'Scoped',
    checkPermissions: async () => {
      invoked++;
      return { behavior: 'allow' };
    },
  };
  assert.deepEqual(await permitted(tool, { value: 'x' }, 'deny'), { behavior: 'deny' });
  assert.equal(invoked, 0, 'global deny must never call the tool-specific permission handler');
  assert.deepEqual(await permitted(tool, { value: 'x' }, 'ask'), { behavior: 'ask' });
  assert.equal(invoked, 1);
  assert.deepEqual(await permitted(tool, { value: 'x' }, 'allow'), { behavior: 'allow' });
  assert.equal(invoked, 2);
});

test('2.1.88 tool checkPermissions can deny but cannot turn a denial into a rewrite/allow', async () => {
  const tool = { name: 'Scoped', checkPermissions: async () => ({
    behavior: 'deny', message: 'blocked destructive operation',
    updatedInput: { value: 'different' },
  }) };
  const result = await permitted(tool, { value: 'original' }, 'allow');
  assert.equal(result.behavior, 'deny');
  assert.match(result.reason, /blocked destructive operation/);
  assert.equal(Object.hasOwn(result, 'updatedInput'), false);

  let executions = 0, approvals = 0;
  const loop = makeLoop({
    permissionPolicy: async () => ({ behavior: 'allow' }),
    checkPermissions: tool.checkPermissions,
    approvalHandler: async () => { approvals++; return true; },
    execute: async () => { executions++; return 'unexpected'; },
    observeResult: block => {
      assert.equal(block.is_error, true);
      assert.match(block.content, /blocked destructive operation/);
    },
  });
  await loop.run({ input: 'execute blocked tool' });
  assert.equal(executions, 0);
  assert.equal(approvals, 0);
});

test('tool-specific ask tightens global allow and requires approval', async () => {
  let approvals = 0, executions = 0;
  const loop = makeLoop({
    permissionPolicy: async () => ({ behavior: 'allow' }),
    checkPermissions: async () => ({ behavior: 'ask', message: 'Confirm this sensitive command.' }),
    approvalHandler: async args => {
      approvals++;
      assert.match(args.reason, /Confirm this sensitive command/);
      return { approved: false, reason: 'Reviewer rejected.' };
    },
    execute: async () => { executions++; return 'unexpected'; },
    observeResult: block => {
      assert.equal(block.is_error, true);
      assert.match(block.content, /Reviewer rejected/);
    },
  });
  await loop.run({ input: 'sensitive action' });
  assert.equal(approvals, 1);
  assert.equal(executions, 0);
});

test('tool-specific updatedInput is schema-revalidated and reauthorized before execution', async () => {
  const seenPolicy = [], seenTool = [], seenValidation = [], executed = [];
  const loop = makeLoop({
    permissionPolicy: async ({ phase, input }) => {
      seenPolicy.push([phase, input.value]);
      return { behavior: 'allow' };
    },
    checkPermissions: async (input, context) => {
      seenTool.push([context.phase, input.value]);
      return input.value === 'before'
        ? { behavior: 'allow', updatedInput: { value: 'after' } }
        : { behavior: 'passthrough' };
    },
    validateInput: async input => {
      seenValidation.push(input.value);
      return { result: true };
    },
    execute: async input => { executed.push(input.value); return input.value; },
    observeResult: block => {
      assert.equal(block.is_error, undefined);
      assert.equal(block.content, 'after');
    },
  });
  await loop.run({ input: 'rewrite my tool call' });
  assert.deepEqual(seenPolicy, [['initial', 'before'], ['recheck', 'after']]);
  assert.deepEqual(seenTool, [['initial', 'before'], ['recheck', 'after']]);
  assert.deepEqual(seenValidation, ['before', 'after']);
  assert.deepEqual(executed, ['after']);
});

test('tool-specific rewrite cannot bypass global policy or invalid input guard', async () => {
  for (const rewrittenValue of ['forbidden', '']) {
    let executed = 0;
    const loop = makeLoop({
      permissionPolicy: async ({ input }) => input.value === 'forbidden'
        ? { behavior: 'deny', reason: 'forbidden after recheck' }
        : { behavior: 'allow' },
      checkPermissions: async input => input.value === 'before'
        ? { behavior: 'allow', updatedInput: { value: rewrittenValue } }
        : { behavior: 'allow' },
      execute: async () => { executed++; return 'unexpected'; },
      observeResult: result => {
        assert.equal(result.is_error, true);
        assert.match(result.content,
          rewrittenValue === '' ? /Invalid tool input returned by permission policy/
            : /forbidden after recheck/);
      },
    });
    await loop.run({ input: 'try rewrite' });
    assert.equal(executed, 0);
  }
});

test('invalid tool-specific decision or callback exception fails closed', async () => {
  for (const checkPermissions of [
    async () => ({ behavior: 'anything' }),
    async () => { throw new Error('permission service crashed'); },
  ]) {
    let executed = 0;
    const loop = makeLoop({
      permissionPolicy: async () => ({ behavior: 'allow' }),
      checkPermissions,
      execute: async () => { executed++; return 'unexpected'; },
      observeResult: block => {
        assert.equal(block.is_error, true);
        assert.match(block.content, /permission check returned an invalid decision|Permission policy failed/);
      },
    });
    await loop.run({ input: 'test tool permission error' });
    assert.equal(executed, 0);
  }
});

test('tool-specific permission adapter does not mutate the model input by reference', async () => {
  const original = { value: 'unchanged' };
  const actual = await resolveToolSpecificPermission({
    tool: { name: 'Scoped', checkPermissions: async input => {
      input.value = 'mutated in callback';
      return { behavior: 'passthrough' };
    } },
    input: original,
    baseDecision: { behavior: 'ask', reason: 'global approval needed' },
  });
  assert.equal(original.value, 'unchanged');
  assert.deepEqual(actual, { behavior: 'ask', reason: 'global approval needed' });
});

test('registry rejects non-callable checkPermissions at registration', () => {
  const tools = new ToolRegistry();
  assert.throws(() => tools.register({
    name: 'Bad', description: 'Invalid tool.', checkPermissions: 'allow', execute: async () => '',
  }), /checkPermissions must be a function/);
});

test('original default-mode ask may be satisfied by exact tool allow, never explicit ask or deny', async () => {
  let toolChecks = 0;
  const tool = { name:'Scoped', checkPermissions:async () => {
    toolChecks++;
    return { behavior:'allow', decisionReason:{
      type:'rule', rule:{ruleBehavior:'allow', ruleValue:{toolName:'Scoped',ruleContent:'safe'}},
    } };
  } };
  const defaultAsk={behavior:'ask',reason:'Default approval',
    decisionReason:{type:'mode',mode:'default'}};
  const exact=await resolveToolSpecificPermission({
    tool,input:{value:'safe'},baseDecision:defaultAsk,
  });
  assert.equal(exact.behavior,'allow');
  assert.equal(exact.decisionReason.type,'rule');
  assert.equal(toolChecks,1);
  for(const baseDecision of [
    {behavior:'ask',reason:'Explicit whole ask',decisionReason:{
      type:'rule',rule:{ruleBehavior:'ask',ruleValue:{toolName:'Scoped'}}}},
    {behavior:'ask',reason:'Hook requires approval'},
    {behavior:'deny',reason:'Global deny'},
  ]) {
    const result=await resolveToolSpecificPermission({
      tool,input:{value:'safe'},baseDecision,
    });
    assert.equal(result.behavior,baseDecision.behavior);
    assert.equal(result.reason,baseDecision.reason);
  }
  assert.equal(toolChecks,3,'denied tool must not execute checkPermissions');
});

test('original default-mode permission allow executes once in actual Query/AgentLoop', async () => {
  let executions=0,approvals=0;
  const loop=makeLoop({
    permissionPolicy:async () => ({
      behavior:'ask',reason:'Default CLI mode',
      decisionReason:{type:'mode',mode:'default'},
    }),
    checkPermissions:async input => input.value==='before'
      ? {behavior:'allow',updatedInput:input} : {behavior:'deny'},
    approvalHandler:async () => {approvals++; return false;},
    execute:async input => {executions++; return input.value;},
    observeResult:block => {
      assert.equal(block.is_error,undefined);
      assert.equal(block.content,'before');
    },
  });
  const result=await loop.run({input:'execute narrowly allowed tool'});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(executions,1);
  assert.equal(approvals,0);
});
