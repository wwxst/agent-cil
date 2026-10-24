import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBuiltinTools } from '../src/index.js';

test('Bash finishes when the shell exits even if a descendant retains its stdio', {
  timeout: 12000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-shell-exit-'));
  let descendantPid;
  try {
    await writeFile(join(workspace, 'worker.cjs'), [
      // A detached descendant deliberately inherits the shell's stdout and
      // stderr handles, but does not write to either one.
      'setTimeout(() => process.exit(0), 5000);',
    ].join('\n'));
    await writeFile(join(workspace, 'launcher.cjs'), [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const worker = spawn(process.execPath, ['worker.cjs'], {",
      "  cwd: process.cwd(), detached: true, windowsHide: true,",
      "  stdio: ['ignore', 'inherit', 'inherit'],",
      "});",
      "fs.writeFileSync('worker-pid.txt', String(worker.pid));",
      "worker.unref();",
      "process.stdout.write('foreground finished\\n');",
    ].join('\n'));

    const tools = await createBuiltinTools({ workspace });
    const started = Date.now();
    const result = await tools.get('Bash').execute({
      command: 'node launcher.cjs',
      timeout_ms: 10000,
    });
    const durationMs = Date.now() - started;
    descendantPid = Number(await readFile(join(workspace, 'worker-pid.txt'), 'utf8'));

    assert.equal(result.exit_code, 0);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /foreground finished/);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    // CLI 2.1.88 ShellCommand uses ChildProcess 'exit', not 'close'.
    // Before this fix the CLI stalls until worker.cjs releases inherited
    // pipe descriptors (~5 s), despite the actual foreground command ending.
    assert.ok(durationMs < 2500,
      'Bash waited ' + durationMs + ' ms for an unrelated descendant to release stdio');
  } finally {
    if (Number.isSafeInteger(descendantPid) && descendantPid > 0) {
      try { process.kill(descendantPid); } catch { /* descendant exited */ }
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
