import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuiltinTools } from '../src/index.js';

test('Windows Bash abort terminates cmd.exe and its Node descendant before it writes', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-windows-tree-'));
  const ac = new AbortController();
  try {
    const script = [
      "const fs=require('node:fs');",
      "fs.writeFileSync('started.txt','running');",
      "setTimeout(()=>{fs.writeFileSync('after-abort.txt','UNSAFE');},1800);",
      "setTimeout(()=>process.exit(0),2700);",
    ].join('\n');
    await writeFile(join(workspace, 'worker.cjs'), script);
    const tools = await createBuiltinTools({ workspace });
    const bash = tools.get('Bash');
    const running = bash.execute({ command: 'node worker.cjs', timeout_ms: 9000 },
      { signal: ac.signal });
    const started = join(workspace, 'started.txt');
    const began = Date.now();
    while (!existsSync(started) && Date.now() - began < 4500) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(existsSync(started), true, 'actual child process never started');
    ac.abort(new Error('user cancelled Bash'));
    await assert.rejects(running, /user cancelled Bash/);
    // Prove a real descendant never continues to produce the delayed effect.
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.equal(existsSync(join(workspace, 'after-abort.txt')), false,
      'child process survived cancellation and wrote after abort');
    assert.equal(await readFile(started, 'utf8'), 'running');
  } finally {
    ac.abort();
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});


test('Windows Bash timeout kills descendants rather than only cmd.exe', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-windows-timeout-'));
  try {
    await writeFile(join(workspace, 'worker.cjs'), [
      "const fs=require('node:fs');",
      "fs.writeFileSync('started.txt','running');",
      "setTimeout(()=>fs.writeFileSync('after-timeout.txt','orphan'),2400);",
      "setTimeout(()=>process.exit(0),3600);",
    ].join('\n'));
    const tools = await createBuiltinTools({ workspace });
    const result = await tools.get('Bash').execute({
      command: 'node worker.cjs', timeout_ms: 1000,
    });
    assert.match(result.error ?? '', /timed out/);
    assert.equal(existsSync(join(workspace, 'started.txt')), true);
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.equal(existsSync(join(workspace, 'after-timeout.txt')), false,
      'a descendant of timed-out Bash survived process-tree termination');
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('Windows Bash output cap kills a descendant that would otherwise keep writing', {
  skip: process.platform !== 'win32',
  timeout: 15000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-windows-output-'));
  try {
    await writeFile(join(workspace, 'worker.cjs'), [
      "const fs=require('node:fs');",
      "fs.writeFileSync('started.txt','running');",
      "process.stdout.write('x'.repeat(1024*1024+65536));",
      "setTimeout(()=>fs.writeFileSync('after-output-limit.txt','orphan'),2400);",
      "setTimeout(()=>process.exit(0),3600);",
    ].join('\n'));
    const tools = await createBuiltinTools({ workspace });
    const result = await tools.get('Bash').execute({
      command: 'node worker.cjs', timeout_ms: 9000,
    });
    assert.match(result.error ?? '', /output exceeded/i);
    assert.equal(existsSync(join(workspace, 'started.txt')), true);
    assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.equal(existsSync(join(workspace, 'after-output-limit.txt')), false,
      'output-limited descendant survived cancellation');
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
