import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry, ToolRegistryError } from '../src/tool-registry.js';
import { invokeToolCallAndMapResult } from '../src/legacy-tools/tool-execution.js';

const schema = {
  type: 'object', properties: { value: { type: 'string' } },
  required: ['value'], additionalProperties: false,
};

function loopWithLegacyTool({ call, mapper, policy = async () => ({ behavior: 'allow' }), onResult }) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'Legacy', description: 'Legacy 2.1.88 shaped tool.',
    inputSchema: schema, call,
    mapToolResultToToolResultBlockParam: mapper,
  });
  let turn = 0;
  const model = {
    async *stream({ messages }) {
      if (turn++ === 0) {
        yield { type: 'tool_use', id: 'legacy-1', name: 'Legacy', input: { value: 'initial' } };
        yield { type: 'message_end', stopReason: 'tool_use' };
        return;
      }
      onResult?.(messages.at(-1).content[0]);
      yield { type: 'text_delta', text: 'complete' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    },
  };
  return new AgentLoop({ model, tools, permissionPolicy: policy });
}

test('ToolRegistry accepts exact 2.1.88 call+mapper pair without changing model tool schema', () => {
  const tools = new ToolRegistry();
  const callback = async () => ({ data: 'hello' });
  const mapper = (data, toolUseId) => ({
    type: 'tool_result', tool_use_id: toolUseId, content: data,
  });
  tools.register({
    name: 'Legacy', description: 'Legacy tool.',
    inputSchema: schema, call: callback,
    mapToolResultToToolResultBlockParam: mapper,
  });
  assert.deepEqual(tools.describe(), [{
    name: 'Legacy', description: 'Legacy tool.', input_schema: schema,
  }]);
  assert.equal(tools.get('Legacy').call, callback);
  assert.equal(tools.get('Legacy').mapToolResultToToolResultBlockParam, mapper);
  assert.throws(() => tools.register({
    name: 'Incomplete', description: 'Incomplete tool.', call: callback,
  }), ToolRegistryError);
  assert.throws(() => tools.register({
    name: 'Duplicated', description: 'Duplicated execution.',
    call: callback, mapToolResultToToolResultBlockParam: mapper,
    execute: async () => 'forbidden',
  }), ToolRegistryError);
});

test('ported 2.1.88 tool.call receives final approved input and maps exactly once', async () => {
  const seen = [];
  let mapped = 0;
  const loop = loopWithLegacyTool({
    policy: async ({ input, phase }) => {
      seen.push(['policy', phase, input.value]);
      return input.value === 'initial'
        ? { behavior: 'allow', updatedInput: { value: 'authorized' } }
        : { behavior: 'allow' };
    },
    call: async (input, context, canUseTool, parentMessage, onProgress) => {
      seen.push(['call', input.value, context.toolUseId]);
      assert.equal(context.messages[0].role, 'user');
      assert.equal(parentMessage.role, 'assistant');
      assert.ok(parentMessage.content.some(b => b.type === 'tool_use'));
      assert.equal(typeof canUseTool, 'function');
      assert.equal(typeof onProgress, 'function');
      const nested = await canUseTool({ name: 'Write', input: { path: '../outside' } });
      assert.equal(nested.behavior, 'deny');
      onProgress({ toolUseID: context.toolUseId, data: { type: 'progress', percent: 100 } });
      return { data: { accepted: input.value } };
    },
    mapper: (data, toolUseId) => {
      mapped += 1;
      assert.equal(toolUseId, 'legacy-1');
      return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(data) };
    },
    onResult: b => {
      assert.equal(b.tool_use_id, 'legacy-1');
      assert.equal(b.is_error, undefined);
      assert.deepEqual(JSON.parse(b.content), { accepted: 'authorized' });
    },
  });
  const progress = [];
  loop.on('toolProgress', ({ progress: event }) => progress.push(event));
  const result = await loop.run({ input: 'invoke a legacy tool' });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(seen, [
    ['policy', 'initial', 'initial'],
    ['policy', 'recheck', 'authorized'],
    ['call', 'authorized', 'legacy-1'],
  ]);
  assert.equal(mapped, 1, 'result mapper must never be called twice');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].data.percent, 100);
});

test('ported legacy call does not execute when permission is denied', async () => {
  let called = 0;
  let mapped = 0;
  const loop = loopWithLegacyTool({
    policy: async () => ({ behavior: 'deny', reason: 'blocked' }),
    call: async () => { called++; return { data: 'not allowed' }; },
    mapper: () => { mapped++; return {}; },
    onResult: block => {
      assert.equal(block.is_error, true);
      assert.match(block.content, /blocked/);
    },
  });
  await loop.run({ input: 'blocked legacy call' });
  assert.equal(called, 0);
  assert.equal(mapped, 0);
});

test('legacy mapper error block is returned faithfully to model', async () => {
  const loop = loopWithLegacyTool({
    call: async () => ({ data: 'domain error' }),
    mapper: (data, toolUseId) => ({
      type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: data }],
      is_error: true,
    }),
    onResult: block => {
      assert.equal(block.is_error, true);
      assert.deepEqual(block.content, [{ type: 'text', text: 'domain error' }]);
    },
  });
  await loop.run({ input: 'domain error through old mapper' });
});

test('legacy mapper cannot forge tool id, return unknown block, or inject non-boolean error', async () => {
  const mappedValues = [
    { type: 'tool_result', tool_use_id: 'someone-else', content: 'forged' },
    { type: 'tool_result', tool_use_id: 'legacy-1', content: [{ type: 'script', text: 'unsafe' }] },
    { type: 'tool_result', tool_use_id: 'legacy-1', content: 'unsafe', is_error: 'yes' },
  ];
  for (const mapped of mappedValues) {
    let calls = 0;
    const loop = loopWithLegacyTool({
      call: async () => { calls++; return { data: 'ignored' }; },
      mapper: () => mapped,
      onResult: block => {
        assert.equal(block.tool_use_id, 'legacy-1');
        assert.equal(block.is_error, true);
        assert.match(block.content, /Tool execution failed/);
      },
    });
    await loop.run({ input: 'validate mapping' });
    assert.equal(calls, 1);
  }
});

test('unsupported legacy side channels are rejected rather than silently dropped', async () => {
  const examples = [
    { data: 'ok', newMessages: [{ role: 'user', content: 'hidden' }] },
    { data: 'ok', contextModifier: () => {} },
    { data: 'ok', mcpMeta: { _meta: { extra: true } } },
    { data: 'ok', structured_output: { extra: true } },
    { unexpected: true },
  ];
  for (const legacyResult of examples) {
    let mapperCalls = 0;
    const loop = loopWithLegacyTool({
      call: async () => legacyResult,
      mapper: () => {
        mapperCalls++;
        return { type: 'tool_result', tool_use_id: 'legacy-1', content: 'ok' };
      },
      onResult: block => {
        assert.equal(block.is_error, true);
        assert.match(block.content, /Tool execution failed/);
      },
    });
    await loop.run({ input: 'unsupported legacy output' });
    assert.equal(mapperCalls, 0);
  }
});

test('legacy tool mapper size cap is fail-closed until 2.1.88 result persistence is ported', async () => {
  const block = { type: 'tool_result', tool_use_id: 'long-id', content: 'x'.repeat(1024 * 1024 + 1) };
  await assert.rejects(invokeToolCallAndMapResult({
    name: 'Large', call: async () => ({ data: 'large' }),
    mapToolResultToToolResultBlockParam: () => block,
  }, {}, { toolUseId: 'long-id' }), /exceeds the 1 MiB mapping limit/);
});

test('existing execute-only tool output serialization remains unchanged', async () => {
  const result = await invokeToolCallAndMapResult({
    name: 'Existing', execute: async () => ({ path: 'safe.txt', written: true }),
  }, {}, { toolUseId: 'existing-1' });
  assert.deepEqual(result, {
    type: 'tool_result', tool_use_id: 'existing-1',
    content: '{"path":"safe.txt","written":true}',
  });
});
