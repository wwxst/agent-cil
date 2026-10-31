import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPersistenceThreshold, processPreMappedToolResultBlock,
  isToolResultContentEmpty, persistToolResult, generatePreview,
  PERSISTED_OUTPUT_TAG, PREVIEW_SIZE_BYTES, buildLargeToolResultMessage,
  applyToolResultBudget, createContentReplacementState,
  reconstructContentReplacementState, MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  TOOL_RESULT_CLEARED_MESSAGE, MAX_PERSISTED_TOOL_RESULT_BYTES,
  ARTIFACT_CONTENT_AUTHORED_BY_OTHERS_PREFIX,
} from '../src/legacy-tools/tool-result-storage.js';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { invokeToolCallAndMapResult } from '../src/legacy-tools/tool-execution.js';

async function tempStore(fn) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cli-original-storage-'));
  const storage = { workspace, directory: join(workspace, '.agent-cil', 'sessions',
    'test-session', 'tool-results') };
  try { return await fn(storage, workspace); }
  finally { await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
function mapped(id, content, is_error = false) {
  return { type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) };
}

test('original 2.1.88 persistence threshold and Read opt-out', () => {
  assert.equal(getPersistenceThreshold('Grep', 100_000), 50_000);
  assert.equal(getPersistenceThreshold('Bash', 4_000), 4_000);
  assert.equal(getPersistenceThreshold('Bash', 200_000, 128_000), 128_000);
  assert.equal(getPersistenceThreshold('Bash', 100_000, 150_000, true), 100_000);
  assert.equal(getPersistenceThreshold('Read', Infinity, 128_000), Infinity);
  assert.deepEqual(generatePreview('abc\n' + 'x'.repeat(4000), PREVIEW_SIZE_BYTES).hasMore, true);
  assert.equal(isToolResultContentEmpty([{ type: 'text', text: '  ' }]), true);
  assert.equal(isToolResultContentEmpty([{ type: 'image', source: {} }]), false);
});

test('2.1.304 per-tool persistence threshold honors persistenceThresholdCeiling', async () => {
  await tempStore(async storage => {
    const content = 'c'.repeat(100_000);
    const block = mapped('ceiling-result', content);
    const processed = await processPreMappedToolResultBlock(
      block, 'CustomTool', 200_000, storage, 150_000, true,
    );
    assert.equal(processed.content, content,
      'the custom 150K ceiling keeps a 100K result inline instead of using the 50K fallback');
    await assert.rejects(
      readFile(join(storage.directory, 'ceiling-result.txt'), 'utf8'),
      { code: 'ENOENT' },
    );
  });
});

test('2.1.304 persisted output is capped by UTF-8 bytes without corrupting code points', async () => {
  await tempStore(async storage => {
    storage.maxPersistBytes = 12;
    const content = 'α'.repeat(10) + 'z'.repeat(10);
    const result = await persistToolResult(content, 'capped-result', storage);
    assert.equal(MAX_PERSISTED_TOOL_RESULT_BYTES, 1_073_741_824);
    assert.equal(result.originalSize, content.length);
    assert.equal(result.truncatedAtBytes, 12);
    assert.equal(await readFile(join(storage.directory, 'capped-result.txt'), 'utf8'),
      'α'.repeat(6), 'only complete UTF-8 code points are written');
    const message = buildLargeToolResultMessage(result);
    assert.match(message, /Output exceeded the 12 B persist limit/);
    assert.match(message, /only the first 12 B were saved/);
  });
});

test('original pre-mapped persistence keeps complete output and sends 2KB reference preview', async () => {
  await tempStore(async storage => {
    const text = 'line of tool output\n'.repeat(6000);
    const block = mapped('large-result', text, true);
    const processed = await processPreMappedToolResultBlock(block, 'Grep', 50_000, storage);
    assert.equal(processed.tool_use_id, 'large-result');
    assert.equal(processed.is_error, true);
    assert.match(processed.content, /^<persisted-output>/);
    assert.match(processed.content, /Full output saved to:/);
    assert.ok(processed.content.length < 3000, 'only original preview is sent to model');
    assert.equal(await readFile(join(storage.directory, 'large-result.txt'), 'utf8'), text);
    const again = await processPreMappedToolResultBlock(block, 'Grep', 50_000, storage);
    assert.equal(again.content, processed.content, 'replayed tool result keeps exact same reference');
    assert.equal(await readFile(join(storage.directory, 'large-result.txt'), 'utf8'), text);
  });
});

test('original empty, image, small and Read results bypass disk writes', async () => {
  await tempStore(async storage => {
    const empty = await processPreMappedToolResultBlock(mapped('empty', ' '), 'Bash', 50_000, storage);
    assert.equal(empty.content, '(Bash completed with no output)');
    const image = mapped('image', [{ type: 'image', source: { type: 'base64',
      media_type: 'image/png', data: 'AA==' } }]);
    assert.deepEqual(await processPreMappedToolResultBlock(image, 'Preview', 50, storage), image);
    const read = mapped('read-large', 'x'.repeat(65_000));
    assert.deepEqual(await processPreMappedToolResultBlock(read, 'Read', Infinity, storage), read);
    assert.deepEqual(await processPreMappedToolResultBlock(mapped('small', 'hello'), 'Grep', 50_000, storage),
      mapped('small', 'hello'));
  });
});

test('source-compatible persistence refuses traversal IDs and symlinked storage trees', async () => {
  await tempStore(async (storage, workspace) => {
    await assert.rejects(persistToolResult('very long', '../escape', storage),
      /Unsafe tool_use ID/);
    await assert.rejects(processPreMappedToolResultBlock(
      mapped('bad-id/other', 'x'.repeat(100)), 'Bash', 50, storage),
      /Unsafe tool_use ID/);
    if (process.platform !== 'win32') {
      const outside = await mkdtemp(join(tmpdir(), 'agent-cli-outside-'));
      try {
        await mkdir(join(workspace, '.agent-cil'), { recursive: true });
        // Earlier rejection-path checks already created this tree.
        await rm(join(workspace, '.agent-cil', 'sessions'), { recursive: true, force: true });
        await symlink(outside, join(workspace, '.agent-cil', 'sessions'));
        await assert.rejects(persistToolResult('x'.repeat(100), 'safe-id', storage),
          /Symlink not permitted/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }
  });
});

test('real AgentLoop sends persisted original tool_result to model without redoing tool.call', async () => {
  await tempStore(async storage => {
    const tools = new ToolRegistry();
    let invoked = 0, rounds = 0;
    tools.register({
      name: 'Huge', description: 'Returns large data',
      maxResultSizeChars: 50_000,
      call: async () => ({ data: 'large result\n'.repeat(7000) }),
      mapToolResultToToolResultBlockParam: (data, id) => mapped(id, data),
    });
    const model = { async *stream({ messages }) {
      rounds++;
      if (rounds === 1) {
        yield { type: 'tool_use', id: 'run-once', name: 'Huge', input: {} };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        const result = messages.at(-1).content[0];
        assert.equal(result.tool_use_id, 'run-once');
        assert.match(result.content, /^<persisted-output>/);
        assert.equal((await readFile(join(storage.directory, 'run-once.txt'), 'utf8')).length,
          'large result\n'.repeat(7000).length);
        yield { type: 'text_delta', text: 'Full result persisted.' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } };
    const loop = new AgentLoop({ model, tools, toolResultStorage: storage,
      permissionPolicy: async () => ({ behavior: 'allow' }) });
    loop.on('toolCallStarted', () => { invoked++; });
    const result = await loop.run({ input: 'run once' });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(invoked, 1);
    assert.match(result.messages[2].content[0].content, /^<persisted-output>/);
    assert.equal(result.messages.at(-1).content[0].text, 'Full result persisted.');
  });
});


test('old storage keeps successful original result when exclusive file write fails', async () => {
  await tempStore(async storage => {
    await mkdir(storage.directory, { recursive: true });
    await mkdir(join(storage.directory, 'blocked.txt'));
    const original = mapped('blocked', 'original output still matters\n'.repeat(3000));
    const response = await processPreMappedToolResultBlock(
      original, 'Grep', 50_000, storage);
    assert.deepEqual(response, original,
      'an I/O failure must not erase successful model-visible tool output');
    await writeFile(join(storage.directory, 'collision.txt'), 'unrelated previous result');
    const collision = mapped('collision', 'new actual result\n'.repeat(5000));
    const notReplaced = await processPreMappedToolResultBlock(
      collision, 'Grep', 50_000, storage);
    assert.deepEqual(notReplaced, collision,
      'an existing file with different contents must not be reported as the new result');
  });
});

test('cancelling active original tool call cannot write a persisted result afterward', async () => {
  await tempStore(async storage => {
    const controller = new AbortController();
    let started;
    const callStarted = new Promise(resolve => { started = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tool = {
      name: 'Huge', maxResultSizeChars: 50_000,
      async call() {
        started();
        await gate;
        return { data: 'late output\n'.repeat(9000) };
      },
      mapToolResultToToolResultBlockParam(data, id) {
        return mapped(id, data);
      },
    };
    const execution = invokeToolCallAndMapResult(tool, {}, {
      toolUseId: 'cancelled-large-tool', signal: controller.signal,
      toolResultStorage: storage,
    });
    await callStarted;
    controller.abort(new Error('operator interrupted tool'));
    release();
    await assert.rejects(execution, /operator interrupted tool/);
    await assert.rejects(access(join(storage.directory, 'cancelled-large-tool.txt')),
      { code: 'ENOENT' }, 'cancelled call must not leave model-visible persisted output');
  });
});


test('2.1.88 aggregate budget persists the largest results in one API user turn, not per tool', async () => {
  await tempStore(async storage => {
    const assistant = { role: 'assistant', content: Array.from({ length: 5 }, (_, i) => ({
      type: 'tool_use', id: 'aggregate-' + i, name: 'Grep', input: {},
    })) };
    const full = 'tool output line\n'.repeat(2500); // 42,500 chars, below the 50K per-tool cap.
    const messages = [
      { role: 'user', content: 'Inspect five independent files.' },
      assistant,
      ...Array.from({ length: 5 }, (_, i) => ({
        role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'aggregate-' + i, content: full,
        }],
      })),
    ];
    const original = structuredClone(messages);
    const state = createContentReplacementState();
    const result = await applyToolResultBudget(messages, state, storage, {
      limit: MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
    });
    assert.equal(result.newlyReplaced.length, 1,
      '212.5K aggregate output requires one 42.5K result to be offloaded');
    assert.equal(result.newlyReplaced[0].toolUseId, 'aggregate-0',
      'equal-sized candidates retain deterministic source order');
    assert.match(result.messages[2].content[0].content, /^<persisted-output>/);
    assert.equal(result.messages[3].content[0].content, full);
    assert.deepEqual(messages, original,
      'provider projection must not mutate the durable source transcript');
    assert.equal(state.seenIds.size, 5);
    assert.equal(state.replacements.size, 1);
    assert.equal(await readFile(join(storage.directory, 'aggregate-0.txt'), 'utf8'), full);
  });
});

test('aggregate budget decisions replay byte-identically after session reconstruction', async () => {
  await tempStore(async storage => {
    const full = 'same output\n'.repeat(3400);
    const messages = [
      { role: 'user', content: 'request' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'replay-a', name: 'Grep', input: {} },
        { type: 'tool_use', id: 'replay-b', name: 'Grep', input: {} },
        { type: 'tool_use', id: 'replay-c', name: 'Grep', input: {} },
        { type: 'tool_use', id: 'replay-d', name: 'Grep', input: {} },
        { type: 'tool_use', id: 'replay-e', name: 'Grep', input: {} },
      ] },
      ...['a', 'b', 'c', 'd', 'e'].map(id => ({
        role: 'user', content: [{
          type: 'tool_result', tool_use_id: 'replay-' + id, content: full,
        }],
      })),
    ];
    const firstState = createContentReplacementState();
    const first = await applyToolResultBudget(messages, firstState, storage);
    assert.equal(first.newlyReplaced.length, 1);
    const resumedState = reconstructContentReplacementState(
      messages, first.newlyReplaced,
    );
    const resumed = await applyToolResultBudget(messages, resumedState, storage);
    assert.deepEqual(resumed.newlyReplaced, []);
    assert.deepEqual(resumed.messages, first.messages,
      'the exact model-visible preview string is restored without re-persisting');
  });
});

test('aggregate budget is per API user turn and honors Read hard opt-out', async () => {
  await tempStore(async storage => {
    const large = 'large result\n'.repeat(9000);
    const separateTurns = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'turn-a', name: 'Grep' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'turn-a', content: large }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'turn-b', name: 'Grep' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'turn-b', content: large }] },
    ];
    const separate = await applyToolResultBudget(
      separateTurns, createContentReplacementState(), storage, { limit: 200_000 },
    );
    assert.deepEqual(separate.newlyReplaced, [],
      'two under-budget API turns must not be combined into one global budget');
    const readTurn = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-budget', name: 'Read' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-budget', content: large }] },
    ];
    const read = await applyToolResultBudget(
      readTurn, createContentReplacementState(), storage,
      { limit: 10, skipToolNames: new Set(['Read']) },
    );
    assert.deepEqual(read.newlyReplaced, [],
      'Read is explicitly exempt because its own maxTokens is the bound');
  });
});

test('AgentLoop applies aggregate replacements to provider requests while retaining full session results', async () => {
  await tempStore(async storage => {
    const tools = new ToolRegistry();
    let executions = 0;
    for (let i = 0; i < 5; i++) {
      tools.register({
        name: 'Grep' + i, description: 'Return one bounded tool result',
        maxResultSizeChars: 50_000,
        inputSchema: { type: 'object', additionalProperties: false },
        execute: async () => { executions++; return 'bounded output\n'.repeat(2700); },
      });
    }
    let round = 0;
    const model = { async *stream({ messages }) {
      round++;
      if (round === 1) {
        for (let i = 0; i < 5; i++) {
          yield { type: 'tool_use', id: 'loop-result-' + i,
            name: 'Grep' + i, input: {} };
        }
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        const blocks = messages.at(-1).content;
        assert.equal(blocks.filter(block => block.type === 'tool_result').length, 5);
        assert.match(blocks[0].content, /^<persisted-output>/);
        assert.equal(blocks[1].content, 'bounded output\n'.repeat(2700));
        yield { type: 'text_delta', text: 'Aggregate result budget applied.' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } };
    const records = [];
    const loop = new AgentLoop({
      model, tools, toolResultStorage: storage,
      contentReplacementEnabled: true,
      toolResultBudgetLimit: 200_000,
      onContentReplacement: async values => records.push(...values),
      permissionPolicy: async () => ({ behavior: 'allow' }),
    });
    const result = await loop.run({ input: 'Run five searches.' });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(executions, 5);
    assert.equal(records.length, 1);
    assert.equal(records[0].toolUseId, 'loop-result-0');
    const persistedHistory = result.messages.filter(message =>
      message.role === 'user' && Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_result'));
    assert.equal(persistedHistory.length, 5);
    assert.equal(persistedHistory[0].content[0].content,
      'bounded output\n'.repeat(2700),
      'the durable transcript retains the original full tool output');
  });
});


test('AgentLoop retry reuses the aggregate replacement decision after a pre-stream failure', async () => {
  await tempStore(async storage => {
    const tools = new ToolRegistry();
    let executions = 0;
    for (let i = 0; i < 5; i++) {
      tools.register({
        name: 'Grep' + i, description: 'Return one bounded tool result',
        maxResultSizeChars: 50_000,
        inputSchema: { type: 'object', additionalProperties: false },
        execute: async () => { executions++; return 'retry output\n'.repeat(3300); },
      });
    }
    let requests = 0;
    let durableMessages;
    const model = { async *stream({ messages: projected }) {
      requests++;
      if (requests === 1) {
        for (let i = 0; i < 5; i++) {
          yield { type: 'tool_use', id: 'retry-' + i, name: 'Grep' + i, input: {} };
        }
        yield { type: 'message_end', stopReason: 'tool_use' };
        return;
      }
      const blocks = projected.at(-1).content;
      assert.match(blocks[0].content, /^<persisted-output>/);
      assert.equal(blocks[1].content, 'retry output\n'.repeat(3300));
      if (requests === 2) throw new Error('temporary pre-stream provider failure');
      yield { type: 'text_delta', text: 'Resumed with the exact saved replacement.' };
      yield { type: 'message_end', stopReason: 'end_turn' };
    } };
    const records = [];
    const loop = new AgentLoop({
      model, tools, toolResultStorage: storage,
      contentReplacementEnabled: true,
      onContentReplacement: async values => records.push(...values),
      onSessionCheckpoint: async checkpoint => {
        if (checkpoint.kind === 'tool') durableMessages = checkpoint.messages;
      },
      permissionPolicy: async () => ({ behavior: 'allow' }),
    });
    await assert.rejects(
      loop.run({ input: 'Run five searches.' }),
      /temporary pre-stream provider failure/,
    );
    assert.ok(Array.isArray(durableMessages),
      'the completed tool batch must be checkpointed before the failed next request');
    assert.equal(executions, 5);
    assert.equal(records.length, 1);
    const resumed = await loop.run({ messages: durableMessages });
    assert.equal(resumed.stopReason, 'end_turn');
    assert.equal(requests, 3);
    assert.equal(executions, 5, 'retry must not replay completed tool side effects');
    assert.equal(records.length, 1,
      'retry must not create a different preview or write a second decision');
    assert.equal(resumed.messages.at(-1).content[0].text,
      'Resumed with the exact saved replacement.');
  });
});


test('2.1.304 aggregate candidates exclude persisted/media output but retain error and truncated results', async () => {
  await tempStore(async storage => {
    const messages = [
      { role: 'assistant', content: [
        ...['error', 'image', 'document', 'truncated', 'cleared', 'persisted', 'artifact', 'eligible']
          .map(id => ({ type: 'tool_use', id, name: 'Grep', input: {} })),
      ] },
      { role: 'user', content: [mapped('error', 'e'.repeat(500), true)] },
      { role: 'user', content: [mapped('image', [{
        type: 'image', source: { type: 'base64', data: 'aGVsbG8=' },
      }])] },
      { role: 'user', content: [mapped('document', [{
        type: 'document', source: { type: 'base64', data: 'aGVsbG8=' },
      }])] },
      { role: 'user', content: [mapped('truncated', '<truncated-output>\\npartial')] },
      { role: 'user', content: [mapped('cleared', TOOL_RESULT_CLEARED_MESSAGE)] },
      { role: 'user', content: [mapped('persisted', PERSISTED_OUTPUT_TAG + '\\npreview\\n</persisted-output>')] },
      { role: 'user', content: [mapped('artifact',
        ARTIFACT_CONTENT_AUTHORED_BY_OTHERS_PREFIX +
        PERSISTED_OUTPUT_TAG + '\\npreview\\n</persisted-output>')] },
      { role: 'user', content: [mapped('eligible', 'eligible output '.repeat(40))] },
    ];
    const state = createContentReplacementState();
    const result = await applyToolResultBudget(messages, state, storage, { limit: 1 });
    assert.deepEqual(result.newlyReplaced.map(record => record.toolUseId),
      ['eligible', 'error', 'truncated']);
    assert.deepEqual([...state.seenIds], ['eligible', 'error', 'truncated']);
  });
});

test('2.1.304 aggregate groups follow assistant message IDs across interleaved assistant/tool-result messages', async () => {
  await tempStore(async storage => {
    const messages = [
      { role: 'assistant', sourceMessageId: 'assistant-A', content: [
        { type: 'tool_use', id: 'a-first', name: 'Grep', input: {} },
      ] },
      { role: 'user', content: [mapped('a-first', 'a'.repeat(120_000))] },
      { role: 'assistant', sourceMessageId: 'assistant-B', content: [
        { type: 'tool_use', id: 'b-middle', name: 'Grep', input: {} },
      ] },
      { role: 'user', content: [mapped('b-middle', 'b'.repeat(100_000))] },
      // The same assistant ID is a continuation, not a new API-message group.
      { role: 'assistant', sourceMessageId: 'assistant-A', content: [
        { type: 'tool_use', id: 'a-last', name: 'Grep', input: {} },
      ] },
      { role: 'user', content: [mapped('a-last', 'c'.repeat(120_000))] },
    ];
    const result = await applyToolResultBudget(
      messages, createContentReplacementState(), storage,
    );
    assert.deepEqual(result.newlyReplaced.map(record => record.toolUseId), ['a-last'],
      'the B + resumed-A wire user turn is 220K and offloads its largest fresh result');
    assert.equal(result.messages[1].content[0].content, 'a'.repeat(120_000));
    assert.equal(result.messages[3].content[0].content, 'b'.repeat(100_000));
    assert.match(result.messages[5].content[0].content, /^<persisted-output>/);
  });
});

test('2.1.304 excludes frozen exempt-tool results from the aggregate budget', async () => {
  await tempStore(async storage => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'frozen-read', name: 'Read', input: {} },
        { type: 'tool_use', id: 'fresh-grep', name: 'Grep', input: {} },
      ] },
      { role: 'user', content: [mapped('frozen-read', 'r'.repeat(150))] },
      { role: 'user', content: [mapped('fresh-grep', 'g'.repeat(50))] },
    ];
    const state = createContentReplacementState();
    state.seenIds.add('frozen-read');
    const result = await applyToolResultBudget(messages, state, storage, {
      limit: 100, skipToolNames: new Set(['Read']),
    });
    assert.deepEqual(result.newlyReplaced, [],
      'the frozen Read result is exempt and must not force the fresh Grep result to offload');
    assert.equal(result.messages, messages);
    assert.equal(state.seenIds.has('fresh-grep'), true);
  });
});

test('2.1.304 skipAggregateToolResultBudget and aliases are honored by the real AgentLoop query path', async () => {
  await tempStore(async storage => {
    const tools = new ToolRegistry();
    let executions = 0;
    const full = 'alias output\\n'.repeat(3300);
    tools.register({
      name: 'LargeOutput',
      aliases: ['LargeOutputAlias'],
      skipAggregateToolResultBudget: true,
      description: 'Return a large but individually bounded result.',
      maxResultSizeChars: 50_000,
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => { executions++; return full; },
    });
    let round = 0;
    const model = { async *stream({ messages }) {
      round++;
      if (round === 1) {
        for (let i = 0; i < 5; i++) {
          yield { type: 'tool_use', id: 'alias-result-' + i,
            name: 'LargeOutputAlias', input: {} };
        }
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        const results = messages.at(-1).content.filter(block => block.type === 'tool_result');
        assert.equal(results.length, 5);
        assert.ok(results.every(block => block.content === full));
        yield { type: 'text_delta', text: 'Exempt alias results were retained.' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } };
    const records = [];
    const loop = new AgentLoop({
      model, tools, toolResultStorage: storage,
      contentReplacementEnabled: true,
      onContentReplacement: async values => records.push(...values),
      permissionPolicy: async () => ({ behavior: 'allow' }),
    });
    const result = await loop.run({ input: 'Call the alias five times.' });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(executions, 5);
    assert.deepEqual(records, []);
  });
});
