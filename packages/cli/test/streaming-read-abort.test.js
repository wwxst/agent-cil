import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools, createCliPermissionPolicy } from '../src/index.js';

test('built-in workspace-only policy explicitly opts in; arbitrary policies do not', async () => {
  const policy = createCliPermissionPolicy();
  assert.equal(policy.supportsStreamingPreflight, true);
  assert.equal(Object.prototype.hasOwnProperty.call(async () => ({ behavior: 'allow' }),
    'supportsStreamingPreflight'), false);
});

test('Read and legacy call mapper receive AbortSignal and reject cancelled file work', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-read-abort-'));
  try {
    await writeFile(join(workspace, 'math.js'), 'const x = 10;\n');
    const tools = await createBuiltinTools({ workspace });
    const read = tools.get('Read');
    assert.equal(read.canRunDuringStream, true);
    const ac = new AbortController();
    ac.abort(new Error('read cancelled by streaming fallback'));
    await assert.rejects(read.execute({ file_path: 'math.js' }, { signal: ac.signal }),
      /read cancelled by streaming fallback/);
    await assert.rejects(read.call({ file_path: 'math.js' }, { signal: ac.signal }),
      /read cancelled by streaming fallback/);
    const alive = await read.execute({ file_path: 'math.js' });
    assert.equal(alive, 'const x = 10;\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Glob and Grep check aborted signals before expensive traversal and file reads', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-search-abort-'));
  try {
    await writeFile(join(workspace, 'a.txt'), 'needle\n');
    const tools = await createBuiltinTools({ workspace });
    const ac = new AbortController();
    ac.abort(new Error('search cancelled by streaming fallback'));
    for (const [name, input] of [
      ['Glob', { pattern: '*.txt' }],
      ['Grep', { pattern: 'needle' }],
    ]) {
      const tool = tools.get(name);
      assert.equal(tool.canRunDuringStream, true);
      await assert.rejects(tool.execute(input, { signal: ac.signal }),
        /search cancelled by streaming fallback/);
    }
    const glob = await tools.get('Glob').execute({ pattern: '*.txt' });
    assert.deepEqual(glob.matches, ['a.txt']);
    const grep = await tools.get('Grep').execute({ pattern: 'needle' });
    assert.equal(grep.matches.length, 1);
    assert.equal(grep.matches[0].text, 'needle');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
