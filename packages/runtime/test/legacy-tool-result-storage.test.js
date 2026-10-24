import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getPersistenceThreshold, processPreMappedToolResultBlock,
  isToolResultContentEmpty, persistToolResult, generatePreview,
  PERSISTED_OUTPUT_TAG, PREVIEW_SIZE_BYTES,
} from '../src/legacy-tools/tool-result-storage.js';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

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
  assert.equal(getPersistenceThreshold('Read', Infinity), Infinity);
  assert.deepEqual(generatePreview('abc\n' + 'x'.repeat(4000), PREVIEW_SIZE_BYTES).hasMore, true);
  assert.equal(isToolResultContentEmpty([{ type: 'text', text: '  ' }]), true);
  assert.equal(isToolResultContentEmpty([{ type: 'image', source: {} }]), false);
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
