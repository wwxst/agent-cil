import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../src/index.js';
import { invokeToolCallAndMapResult } from '../../runtime/src/legacy-tools/tool-execution.js';

test('built-in Read uses migrated Tool.call and mapper without replacing secure direct execute', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-read-legacy-port-'));
  try {
    await writeFile(join(workspace, 'src.txt'), 'alpha\nbeta\n');
    const registry = await createBuiltinTools({ workspace });
    const read = registry.get('Read');
    assert.equal(typeof read.execute, 'function');
    assert.equal(typeof read.call, 'function');
    assert.equal(typeof read.mapToolResultToToolResultBlockParam, 'function');

    const input = { file_path: 'src.txt' };
    assert.equal(await read.execute(input), 'alpha\nbeta\n');
    assert.deepEqual(await read.call(input), { data: 'alpha\nbeta\n' });
    assert.deepEqual(read.mapToolResultToToolResultBlockParam('text', 'read-1'), {
      type: 'tool_result', tool_use_id: 'read-1', content: 'text',
    });

    const result = await invokeToolCallAndMapResult(read, input, {
      toolUseId: 'read-real-port', assistantMessage: { role: 'assistant', content: [] },
    });
    assert.deepEqual(result, {
      type: 'tool_result', tool_use_id: 'read-real-port',
      content: 'alpha\nbeta\n',
    });
    assert.deepEqual(await registry.validateInput('Read', input), []);
    await assert.rejects(read.execute({ file_path: '../outside.txt' }), /escapes the workspace/);
    await assert.rejects(read.call({ file_path: '../outside.txt' }), /escapes the workspace/);
    assert.equal(await readFile(join(workspace, 'src.txt'), 'utf8'), 'alpha\nbeta\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
