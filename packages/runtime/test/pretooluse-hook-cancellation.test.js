import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCommandHook } from '../src/legacy-tools/pretooluse-node-compat.js';

async function withCommand(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-cil-hook-cancel-'));
  try {
    await writeFile(join(cwd, 'slow.cjs'),
      'setTimeout(() => process.stdout.write("too-late"), 8000);');
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
test('running PreToolUse hook honors abort and cleans up without hanging', {
  timeout: 12000,
}, async () => {
  await withCommand(async cwd => {
    const controller = new AbortController();
    const started = Date.now();
    const executing = execCommandHook('node slow.cjs', {
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {},
    }, cwd, controller.signal, 9000);
    setTimeout(() => controller.abort(new Error('Stop running this hook')), 200);
    await assert.rejects(executing, /Stop running this hook/);
    assert.ok(Date.now() - started < 5000, 'active Hook abort must release subprocess handles');
  });
});
test('running PreToolUse hook honors timeout without waiting for command completion', {
  timeout: 12000,
}, async () => {
  await withCommand(async cwd => {
    const started = Date.now();
    await assert.rejects(execCommandHook('node slow.cjs', {
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {},
    }, cwd, new AbortController().signal, 350), /timed out/);
    assert.ok(Date.now() - started < 5000, 'timeout must not leave Hook process running');
  });
});
