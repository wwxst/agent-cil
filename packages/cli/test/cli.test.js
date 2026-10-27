import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AgentLoop } from '../../runtime/src/agent-loop.js';
import { applyPermissionUpdates } from '../../runtime/src/legacy-permissions/permission-update.js';
import {
  CliArgumentError,
  createBuiltinTools,
  createCliPermissionContext,
  createCliPermissionPolicy,
  main,
  parseArgs,
  resolveWorkspacePath,
} from '../src/index.js';

test('version and help are handled before model credentials are needed', () => {
  assert.deepEqual(parseArgs(['--version']), { mode: 'version' });
  assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
});

test('executable version fast path exits without credentials', () => {
  const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'agent-cil 0.1.0\n');
  assert.equal(result.stderr, '');
});

test('CLI rejects missing and non-directory workspaces before model requests', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-cil-invalid-cwd-'));
  const notDirectory = join(parent, 'not-a-directory');
  const missing = join(parent, 'missing');
  const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  try {
    await writeFile(notDirectory, 'file, not a directory');
    for (const workspace of [missing, notDirectory]) {
      const result = spawnSync(process.execPath, [
        cliPath, '--print', 'hello', '--cwd', workspace,
      ], {
        encoding: 'utf8',
        env: { ...process.env, ANTHROPIC_API_KEY: 'test-key' },
      });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Workspace directory is unavailable/);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('parses model, endpoint, token, system, cwd, print and prompt options', () => {
  const options = parseArgs([
    '--print',
    '--model', 'claude-test-model',
    '--base-url=https://example.test',
    '--max-tokens', '2048',
    '--max-turns=12',
    '--max-retries=1',
    '--allow-edits',
    '--system', 'Be precise.',
    '--cwd', '/tmp/project',
    'explain', 'this repository',
  ]);
  assert.equal(options.print, true);
  assert.equal(options.model, 'claude-test-model');
  assert.equal(options.baseUrl, 'https://example.test');
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.maxTurns, 12);
  assert.equal(options.maxRetries, 1);
  assert.equal(options.allowEdits, true);
  assert.equal(options.system, 'Be precise.');
  assert.equal(options.cwd, resolve('/tmp/project'));
  assert.equal(options.prompt, 'explain this repository');
});

test('rejects unknown options and invalid max token values', () => {
  assert.throws(() => parseArgs(['--unknown']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-tokens', '0']), CliArgumentError);
  assert.throws(() => parseArgs(['--model']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-turns', '0']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-turns=101']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-turns', 'one']), CliArgumentError);
  assert.equal(parseArgs(['hello']).maxTurns, 8);
  assert.equal(parseArgs(['hello']).maxRetries, 2);
  assert.equal(parseArgs(['hello']).allowEdits, false);
  assert.throws(() => parseArgs(['--max-retries', '-1']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-retries', '6']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-retries=wrong']), CliArgumentError);
});

test('CLI rejects a remote plaintext API endpoint during startup', async () => {
  await assert.rejects(
    main(['--print', 'hello', '--base-url', 'http://example.test'], {
      ANTHROPIC_API_KEY: 'local-test-key',
    }),
    /must use HTTPS unless it targets localhost or a loopback address/,
  );
});

test('workspace path resolution rejects traversal outside the workspace', () => {
  const root = resolve('/tmp/agent-cil-workspace');
  assert.equal(resolveWorkspacePath(root, 'src/index.js'), join(root, 'src', 'index.js'));
  assert.throws(() => resolveWorkspacePath(root, '../outside.txt'), /escapes the workspace/);
});

test('CLI permission policy checks final Write/Edit paths before asking for approval', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-policy-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-cil-policy-outside-'));
  try {
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, join(workspace, 'linked.txt'));
    const policy = createCliPermissionPolicy({ workspace });

    assert.equal((await policy({ name: 'Read', input: { file_path: 'safe.txt' } })).behavior, 'allow');
    assert.equal((await policy({ name: 'Grep', input: { pattern: 'needle', path: '.' } })).behavior, 'allow');
    assert.equal((await policy({ name: 'Glob', input: { pattern: '*.js' } })).behavior, 'allow');
    assert.equal((await policy({ name: 'Write', input: { file_path: 'safe/new.txt' } })).behavior, 'ask');
    assert.equal((await policy({ name: 'Edit', input: { file_path: 'safe/new.txt' } })).behavior, 'ask');

    const traversal = await policy({ name: 'Write', input: { file_path: '../outside.txt' } });
    assert.equal(traversal.behavior, 'deny');
    assert.match(traversal.reason, /escapes the workspace/);

    const symlinkWrite = await policy({ name: 'Write', input: { file_path: 'linked.txt' } });
    assert.equal(symlinkWrite.behavior, 'deny');
    assert.match(symlinkWrite.reason, /Symbolic links are not allowed/);
    const symlinkRead = await policy({ name: 'Read', input: { file_path: 'linked.txt' } });
    assert.equal(symlinkRead.behavior, 'deny');
    assert.match(symlinkRead.reason, /Symbolic links are not allowed/);
    const grepTraversal = await policy({ name: 'Grep', input: { pattern: 'secret', path: '../outside' } });
    assert.equal(grepTraversal.behavior, 'deny');
    assert.match(grepTraversal.reason, /escapes the workspace/);
    const globTraversal = await policy({ name: 'Glob', input: { pattern: '../*.js' } });
    assert.equal(globTraversal.behavior, 'deny');
    assert.match(globTraversal.reason, /Glob pattern must stay within the workspace/);

    assert.equal((await policy({ name: 'Bash', input: { command: 'echo hello' } })).behavior, 'ask');
    assert.equal((await policy({ name: 'unexpected', input: {} })).behavior, 'deny');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('AgentLoop rechecks CLI workspace permissions after Write input is replaced', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-policy-runtime-'));
  const escapedName = workspace.split(/[\\/]/).at(-1) + '-escaped.txt';
  const escapedPath = join(workspace, '..', escapedName);
  let approvalCalls = 0;
  try {
    const tools = await createBuiltinTools({ workspace });
    const cliPolicy = createCliPermissionPolicy({ workspace });
    const model = {
      async *stream() {
        yield {
          type: 'tool_use',
          id: 'cli-policy-write-1',
          name: 'Write',
          input: { file_path: 'safe.txt', content: 'original input' },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
      },
    };
    const loop = new AgentLoop({
      model,
      tools,
      permissionPolicy: async context => {
        const decision = await cliPolicy(context);
        if (context.phase === 'initial' && context.name === 'Write' && decision.behavior === 'ask') {
          return {
            ...decision,
            updatedInput: { file_path: '../' + escapedName, content: 'must never be written' },
          };
        }
        return decision;
      },
      approvalHandler: async () => {
        approvalCalls += 1;
        return true;
      },
      maxTurns: 1,
    });

    const result = await loop.run({ input: 'Write a file.' });
    const toolResult = result.messages.at(-1).content[0];
    assert.equal(approvalCalls, 0, 'the escaped replacement must be denied before approval');
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /File target is not authorized/);
    await assert.rejects(readFile(escapedPath), { code: 'ENOENT' });
    await assert.rejects(readFile(join(workspace, 'safe.txt')), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(escapedPath, { force: true });
  }
});

test('AgentLoop denies a rewritten Edit target outside the workspace before approval', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-edit-policy-'));
  const escapedName = workspace.split(/[\\/]/).at(-1) + '-edit-escaped.txt';
  const escapedPath = join(workspace, '..', escapedName);
  let approvalCalls = 0;
  try {
    const tools = await createBuiltinTools({ workspace });
    const cliPolicy = createCliPermissionPolicy({ workspace });
    const model = {
      async *stream() {
        yield {
          type: 'tool_use',
          id: 'cli-policy-edit-1',
          name: 'Edit',
          input: { file_path: 'safe.txt', old_string: 'before', new_string: 'after' },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
      },
    };
    const loop = new AgentLoop({
      model,
      tools,
      permissionPolicy: async context => {
        const decision = await cliPolicy(context);
        if (context.phase === 'initial' && context.name === 'Edit' && decision.behavior === 'ask') {
          return {
            ...decision,
            updatedInput: {
              file_path: '../' + escapedName,
              old_string: 'before',
              new_string: 'must never be written',
            },
          };
        }
        return decision;
      },
      approvalHandler: async () => {
        approvalCalls += 1;
        return true;
      },
      maxTurns: 1,
    });

    const result = await loop.run({ input: 'Edit a file.' });
    const toolResult = result.messages.at(-1).content[0];
    assert.equal(approvalCalls, 0, 'an escaped Edit target must be denied before approval');
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /File target is not authorized/);
    await assert.rejects(readFile(escapedPath), { code: 'ENOENT' });
    await assert.rejects(readFile(join(workspace, 'safe.txt')), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(escapedPath, { force: true });
  }
});

test('Write refuses a symlink installed during the approval window', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-write-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-cil-write-race-outside-'));
  const outsideFile = join(outside, 'secret.txt');
  const target = join(workspace, 'race.txt');
  try {
    await writeFile(outsideFile, 'keep this secret');
    const tools = await createBuiltinTools({ workspace });
    const model = {
      async *stream() {
        yield {
          type: 'tool_use',
          id: 'cli-write-race-1',
          name: 'Write',
          input: { file_path: 'race.txt', content: 'must not overwrite outside data' },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
      },
    };
    const loop = new AgentLoop({
      model,
      tools,
      permissionPolicy: createCliPermissionPolicy({ workspace }),
      approvalHandler: async () => {
        // Simulate the target changing after the policy check but before tool execution.
        await symlink(outsideFile, target);
        return { approved: true };
      },
      maxTurns: 1,
    });

    const result = await loop.run({ input: 'Write a file.' });
    const toolResult = result.messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /Symbolic links are not allowed/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'keep this secret');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Edit refuses a symlink installed during the approval window', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-edit-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-cil-edit-race-outside-'));
  const outsideFile = join(outside, 'secret.txt');
  const target = join(workspace, 'race.txt');
  try {
    await writeFile(outsideFile, 'keep this secret');
    await writeFile(target, 'before');
    const tools = await createBuiltinTools({ workspace });
    const model = {
      async *stream() {
        yield {
          type: 'tool_use',
          id: 'cli-edit-race-1',
          name: 'Edit',
          input: { file_path: 'race.txt', old_string: 'before', new_string: 'must not overwrite outside data' },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
      },
    };
    const loop = new AgentLoop({
      model,
      tools,
      permissionPolicy: createCliPermissionPolicy({ workspace }),
      approvalHandler: async () => {
        await rm(target);
        await symlink(outsideFile, target);
        return { approved: true };
      },
      maxTurns: 1,
    });

    const result = await loop.run({ input: 'Edit a file.' });
    const toolResult = result.messages.at(-1).content[0];
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /Symbolic links are not allowed/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'keep this secret');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('AgentLoop does not execute a Bash command when interactive approval is denied', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-bash-denied-'));
  const marker = join(workspace, 'must-not-exist.txt');
  const script = 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "executed")';
  const encodedScript = Buffer.from(script).toString('base64');
  const command = JSON.stringify(process.execPath) + ' -e "eval(Buffer.from(\'' + encodedScript + '\', \'base64\').toString())"';
  let approvalCalls = 0;
  try {
    const tools = await createBuiltinTools({ workspace });
    const cliPolicy = createCliPermissionPolicy({ workspace });
    const model = {
      async *stream() {
        yield {
          type: 'tool_use',
          id: 'cli-bash-denied-1',
          name: 'Bash',
          input: { command },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
      },
    };
    const loop = new AgentLoop({
      model,
      tools,
      permissionPolicy: cliPolicy,
      approvalHandler: async ({ name, input }) => {
        approvalCalls += 1;
        assert.equal(name, 'Bash');
        assert.ok(input.command.includes('Buffer.from'));
        assert.ok(input.command.includes('base64'));
        return { approved: false, reason: 'User rejected the shell command.' };
      },
      maxTurns: 1,
    });

    const result = await loop.run({ input: 'Create a marker file.' });
    const toolResult = result.messages.at(-1).content[0];
    assert.equal(approvalCalls, 1);
    assert.equal(toolResult.is_error, true);
    assert.match(toolResult.content, /User rejected the shell command/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('AgentLoop requests approval for the final Bash command after policy input replacement', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-bash-policy-'));
  const policyCalls = [];
  const approvalInputs = [];
  try {
    const tools = await createBuiltinTools({ workspace });
    const cliPolicy = createCliPermissionPolicy({ workspace });
    const model = {
      async *stream() {
        yield {
          type: 'tool_use',
          id: 'cli-policy-bash-1',
          name: 'Bash',
          input: { command: 'node -p 1+1' },
        };
        yield { type: 'message_end', stopReason: 'tool_use' };
      },
    };
    const loop = new AgentLoop({
      model,
      tools,
      permissionPolicy: async context => {
        const decision = await cliPolicy(context);
        policyCalls.push({ phase: context.phase, command: context.input.command, behavior: decision.behavior });
        if (context.phase === 'initial') {
          return { ...decision, updatedInput: { command: 'node -p 2+2' } };
        }
        return decision;
      },
      approvalHandler: async ({ input }) => {
        approvalInputs.push(input.command);
        return { approved: true };
      },
      maxTurns: 1,
    });

    const result = await loop.run({ input: 'Run a command.' });
    const toolResult = result.messages.at(-1).content[0];
    assert.deepEqual(policyCalls, [
      { phase: 'initial', command: 'node -p 1+1', behavior: 'ask' },
      { phase: 'recheck', command: 'node -p 2+2', behavior: 'ask' },
      { phase: 'post-approval', command: 'node -p 2+2', behavior: 'ask' },
    ]);
    assert.deepEqual(approvalInputs, ['node -p 2+2']);
    assert.equal(toolResult.is_error, undefined);
    const output = JSON.parse(toolResult.content);
    assert.equal(output.exit_code, 0);
    assert.equal(output.stdout.trim(), '4');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('built-in tools provide read, write and unique-match edit operations', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-cli-'));
  try {
    const tools = await createBuiltinTools({ workspace });
    assert.deepEqual(tools.list().map((tool) => tool.name), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TaskOutput', 'TaskStop']);

    await tools.get('Write').execute({ file_path: 'src/example.js', content: 'const value = 1;\n' });
    assert.equal(await tools.get('Read').execute({ file_path: 'src/example.js' }), 'const value = 1;\n');

    await tools.get('Write').execute({ file_path: 'src/example.js', content: 'const value = 1; // overwritten\n' });
    assert.equal(await tools.get('Read').execute({ file_path: 'src/example.js' }), 'const value = 1; // overwritten\n');

    await tools.get('Edit').execute({
      file_path: 'src/example.js',
      old_string: 'value = 1',
      new_string: 'value = 2',
    });
    assert.equal(await readFile(join(workspace, 'src/example.js'), 'utf8'), 'const value = 2; // overwritten\n');

    await assert.rejects(
      tools.get('Edit').execute({
        file_path: 'src/example.js',
        old_string: 'value = 1',
        new_string: 'let',
      }),
      /old_string was not found|occurs more than once/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Read rejects binary files and text files above the 1 MiB limit', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-read-limits-'));
  try {
    await writeFile(join(workspace, 'binary.dat'), Buffer.from([65, 0, 66]));
    await writeFile(join(workspace, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
    const tools = await createBuiltinTools({ workspace });

    await assert.rejects(
      tools.get('Read').execute({ file_path: 'binary.dat' }),
      /binary file/,
    );
    await assert.rejects(
      tools.get('Read').execute({ file_path: 'large.txt' }),
      /1 MiB read limit/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Bash tool executes a command in the workspace and captures its output', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-bash-'));
  try {
    const tools = await createBuiltinTools({ workspace });
    const result = await tools.get('Bash').execute({ command: 'node -p 1+1' });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout.trim(), '2');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});


test('source Bash TaskOutput spills combined stdout/stderr to a complete retained output file', {
  timeout:20000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-bash-task-output-'));
  const scriptPath=join(workspace,'large-output.cjs');
  try {
    await writeFile(scriptPath,[
      'process.stdout.write("A".repeat(650000));',
      'process.stderr.write("B".repeat(550000));',
      'process.stdout.write("DONE\\n");',
    ].join('\n'));
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      scriptPath.replaceAll('"','')+'"';
    const tools = await createBuiltinTools({ workspace });
    const result = await tools.get('Bash').execute({ command, timeout_ms: 10000 });
    assert.equal(result.exit_code,0,
      'source TaskOutput must not kill a successful command on 1 MiB stdout');
    assert.equal(result.error,undefined);
    assert.match(result.stdout,/Output truncated/);
    assert.match(result.stdout,/Full output saved to:/);
    assert.equal(result.stderr,'',
      'source TaskOutput stores overflowing stderr with a [stderr] marker');
    assert.match(result.outputTaskId,/^[a-f0-9-]{36}$/i);
    assert.equal(result.outputFilePath.endsWith(result.outputTaskId+'.output'),true);
    const persisted=await readFile(result.outputFilePath,'utf8');
    assert.ok(persisted.length>=1200000,
      'complete stdout and stderr must survive the 1 MiB inline boundary');
    assert.ok(persisted.includes('A'.repeat(10000)));
    assert.ok(persisted.includes('B'.repeat(10000)));
    assert.equal(persisted.includes('[stderr]'),false,
      'original file mode interleaves stdout/stderr via the same FD, without pipe markers');
    assert.ok(persisted.includes('DONE'));
    assert.equal(result.outputFileSize,Buffer.byteLength(persisted));
    assert.ok(Buffer.byteLength(result.stdout)<30*1024,
      'model tool result must not include all 1.2MB output');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Bash timeout kills a SIGTERM-resistant descendant before its delayed side effect', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-bash-timeout-'));
  const marker = join(workspace, 'late-timeout-side-effect.txt');
  const script = 'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "late"), 1800)';
  const encodedScript = Buffer.from(script).toString('base64');
  const command = JSON.stringify(process.execPath) + " -e \"eval(Buffer.from('" + encodedScript + "', 'base64').toString())\" >/dev/null 2>&1 & wait";
  try {
    const tools = await createBuiltinTools({ workspace });
    const result = await tools.get('Bash').execute({ command, timeout_ms: 1000 });
    assert.match(result.error, /killed or timed out/);
    await new Promise(resolve => setTimeout(resolve, 1000));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Bash cancellation terminates a background descendant before its delayed side effect', {
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-bash-abort-'));
  const marker = join(workspace, 'late-side-effect.txt');
  const script = 'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "late"), 700)';
  const encodedScript = Buffer.from(script).toString('base64');
  const command = `${JSON.stringify(process.execPath)} -e "eval(Buffer.from('${encodedScript}', 'base64').toString())" >/dev/null 2>&1 & wait`;
  const controller = new AbortController();
  const tools = await createBuiltinTools({ workspace });
  const execution = tools.get('Bash').execute(
    { command, timeout_ms: 5000 },
    { signal: controller.signal },
  );
  const abortTimer = setTimeout(() => controller.abort(new Error('test cancellation')), 75);

  try {
    await assert.rejects(execution, /test cancellation/);
    await new Promise(resolve => setTimeout(resolve, 850));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    clearTimeout(abortTimer);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('CLI streams a model response, executes Read, and feeds tool_result into the next request', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-e2e-'));
  const requests = [];
  const sse = (type, fields = {}) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const responses = [
    [
      sse('message_start', { message: { usage: { input_tokens: 3 } } }),
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'cli-read-1', name: 'Read', input: {} },
      }),
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"note.txt"}' },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      sse('message_stop'),
    ].join(''),
    [
      sse('message_start', { message: { usage: { input_tokens: 8 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'I read it: hello from file.' },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }),
      sse('message_stop'),
    ].join(''),
  ];

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    response.end(responses[Math.min(requests.length - 1, responses.length - 1)]);
  });

  try {
    await writeFile(join(workspace, 'note.txt'), 'hello from file\n');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const child = spawn(process.execPath, [
      cliPath,
      '--print',
      'Read note.txt and tell me what it says.',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + address.port,
      '--model', 'claude-local-test',
      '--system', 'Use concise responses.',
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'local-test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [exitCode, exitSignal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });

    assert.equal(exitSignal, null);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.trim(), 'I read it: hello from file.');
    assert.equal(requests.length, 2, 'the tool call should cause a second model request');
    assert.equal(requests[0].model, 'claude-local-test');
    assert.equal(requests[0].system, 'Use concise responses.');
    assert.equal(requests[1].system, 'Use concise responses.');
    assert.equal(requests[0].stream, true);

    const assistantToolMessage = requests[1].messages.find(message =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_use' && block.id === 'cli-read-1'),
    );
    assert.ok(assistantToolMessage, 'second request must preserve the assistant tool_use block');

    const toolResultMessage = requests[1].messages.find(message =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'cli-read-1'),
    );
    assert.ok(toolResultMessage, 'second request must include the matching tool_result');
    assert.match(
      toolResultMessage.content.find(block => block.type === 'tool_result').content,
      /hello from file/,
    );
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});


test('CLI denies Write in non-interactive print mode and returns the denial to the model', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-deny-write-'));
  const requests = [];
  const sse = (type, fields = {}) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const responses = [
    [
      sse('message_start', { message: { usage: { input_tokens: 2 } } }),
      sse('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'cli-write-1', name: 'Write', input: {} },
      }),
      sse('content_block_delta', {
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"file_path":"created.txt","content":"should not be written"}',
        },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      sse('message_stop'),
    ].join(''),
    [
      sse('message_start', { message: { usage: { input_tokens: 6 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'The write was denied.' },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      sse('message_stop'),
    ].join(''),
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    response.end(responses[Math.min(requests.length - 1, responses.length - 1)]);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const child = spawn(process.execPath, [
      cliPath,
      '--print',
      'Create created.txt with the requested content.',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + address.port,
      '--model', 'claude-local-test',
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'local-test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [exitCode, exitSignal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });

    assert.equal(exitSignal, null);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.trim(), 'The write was denied.');
    assert.match(stderr, /denied Write: interactive approval is unavailable/);
    await assert.rejects(readFile(join(workspace, 'created.txt')), { code: 'ENOENT' });
    assert.equal(requests.length, 2);

    const toolResultMessage = requests[1].messages.find(message =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'cli-write-1'),
    );
    assert.ok(toolResultMessage, 'the model must receive a result for the denied tool call');
    const resultBlock = toolResultMessage.content.find(block => block.type === 'tool_result');
    assert.equal(resultBlock.is_error, true);
    assert.match(resultBlock.content, /Tool call denied/);
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('file tools reject symbolic links that resolve outside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-safe-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-cil-outside-'));
  try {
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, join(workspace, 'linked.txt'));
    await symlink(join(outside, 'missing.txt'), join(workspace, 'broken-link.txt'));
    const tools = await createBuiltinTools({ workspace });
    await assert.rejects(tools.get('Read').execute({ file_path: 'linked.txt' }), /Symbolic links are not allowed/);
    await assert.rejects(tools.get('Write').execute({ file_path: 'linked.txt', content: 'overwrite' }), /Symbolic links are not allowed/);
    await assert.rejects(tools.get('Write').execute({ file_path: 'broken-link.txt', content: 'create outside' }), /Symbolic links are not allowed/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'secret');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test('Grep reports truncated results when workspace traversal reaches the file cap', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-grep-walk-cap-'));
  try {
    const totalFiles = 5001;
    for (let start = 0; start < totalFiles; start += 100) {
      const batch = Array.from(
        { length: Math.min(100, totalFiles - start) },
        (_, offset) => writeFile(join(workspace, 'file-' + (start + offset) + '.txt'), 'no match here'),
      );
      await Promise.all(batch);
    }

    const tools = await createBuiltinTools({ workspace });
    const grep = await tools.get('Grep').execute({ pattern: 'never-match-this-token' });
    assert.deepEqual(grep.matches, []);
    assert.equal(grep.truncated, true, 'the bounded walk must not be reported as exhaustive');

    const glob = await tools.get('Glob').execute({ pattern: '*.txt' });
    assert.equal(glob.matches.length, 500);
    assert.equal(glob.truncated, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Glob and Grep search within the workspace and return relative paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-search-'));
  try {
    await writeFile(join(workspace, 'alpha.js'), 'export const needle = true;\n');
    await writeFile(join(workspace, 'beta.txt'), 'nothing here\n');
    const tools = await createBuiltinTools({ workspace });
    const glob = await tools.get('Glob').execute({ pattern: '*.js' });
    assert.deepEqual(glob.matches, ['alpha.js']);

    const grep = await tools.get('Grep').execute({ pattern: 'needle' });
    assert.equal(grep.matches.length, 1);
    assert.equal(grep.matches[0].path, 'alpha.js');
    assert.equal(grep.matches[0].line, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});


test('TTY positional prompt remains interactive and preserves history for the next turn', {
  skip: process.platform !== 'linux' || spawnSync('script', ['--version'], { stdio: 'ignore' }).status !== 0,
  timeout: 15000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tty-history-'));
  const requests = [];
  const sse = (type, fields = {}) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const assistantResponse = text => [
    sse('message_start', { message: { usage: { input_tokens: 3 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    sse('message_stop'),
  ].join('');
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
    res.end(assistantResponse(requests.length === 1 ? 'FIRST_RESPONSE_OK' : 'SECOND_RESPONSE_OK'));
  });

  let child;
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const command = [
      process.execPath,
      cliPath,
      '--model', 'local-tty-fixture',
      '--base-url', 'http://127.0.0.1:' + addr.port,
      '--cwd', workspace,
      'first prompt',
    ].map(quote).join(' ');

    child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'local-tty-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let promptCount = 0;
    let sentFollowUp = false;
    let sentExit = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const found = (output.match(/you> /g) || []).length;
      if (found > promptCount) promptCount = found;
      if (promptCount >= 1 && !sentFollowUp) {
        sentFollowUp = true;
        child.stdin.write('second prompt\n');
      }
      if (promptCount >= 2 && !sentExit) {
        sentExit = true;
        child.stdin.write('/exit\n');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timeout = setTimeout(() => { child.kill('SIGKILL'); }, 9000);
    const [status, sig] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });

    assert.equal(sig, null, 'TTY test process timed out: ' + output + '\n' + stderr);
    assert.equal(status, 0, output + '\n' + stderr);
    assert.ok(sentExit, 'CLI never offered a second interactive prompt: ' + output);
    assert.match(output, /FIRST_RESPONSE_OK/);
    assert.match(output, /SECOND_RESPONSE_OK/);
    assert.equal(requests.length, 2);
    const secondMessages = requests[1].messages;
    assert.ok(secondMessages.some(m => m.role === 'user' && m.content === 'first prompt'));
    assert.ok(secondMessages.some(m => m.role === 'assistant' &&
      Array.isArray(m.content) && m.content.some(block => block.text === 'FIRST_RESPONSE_OK')));
    assert.ok(secondMessages.some(m => m.role === 'user' && m.content === 'second prompt'));
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});


test('CLI SIGINT aborts an in-flight streaming model request and exits with 130', {
  skip: process.platform === 'win32',
  timeout: 12000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-sigint-'));
  let requests = 0;
  let connectionClosed = false;
  const sse = (type, fields = {}) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const server = createServer(async (req, res) => {
    requests += 1;
    for await (const _chunk of req) { /* drain the request before replying */ }
    res.on('close', () => { connectionClosed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.write(sse('message_start', { message: { usage: { input_tokens: 2 } } }));
    res.write(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'INTERRUPT_READY' } }));
    // Deliberately hold the SSE stream open until the CLI aborts fetch().
  });

  let child;
  let watchdog;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    child = spawn(process.execPath, [
      cliPath, '--print', 'stream a message',
      '--cwd', workspace,
      '--model', 'local-cancel-fixture',
      '--base-url', 'http://127.0.0.1:' + address.port,
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'local-cancel-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let interrupted = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!interrupted && stdout.includes('INTERRUPT_READY')) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => { child.kill('SIGKILL'); }, 7500);

    const [exitCode, exitSignal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    assert.equal(requests, 1);
    assert.equal(interrupted, true, 'model text was never streamed: ' + stderr);
    assert.equal(exitSignal, null, 'CLI did not stop cleanly: ' + stderr);
    assert.equal(exitCode, 130, 'SIGINT should exit 130, got stderr: ' + stderr);
    assert.match(stdout, /INTERRUPT_READY/);
    assert.match(stderr, /Interrupted by user/);
    assert.equal(connectionClosed, true, 'stream transport was not closed after cancellation');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});


test('CLI returns a failure status when model output or tool rounds end without a final answer', {
  timeout: 20000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-incomplete-'));
  const requests = [];
  let fixture = 'max_tokens';
  const sse = (type, fields = {}) =>
    'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const modelResponse = () => fixture === 'max_tokens'
    ? [
      sse('message_start', { message: { usage: { input_tokens: 2 } } }),
      sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'PARTIAL_ANSWER' } }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4 } }),
      sse('message_stop'),
    ].join('')
    : [
      sse('message_start', { message: { usage: { input_tokens: 2 } } }),
      sse('content_block_start', {
        index: 0, content_block: { type: 'tool_use', id: 'read-limit-1', name: 'Read', input: {} },
      }),
      sse('content_block_delta', {
        index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"example.txt"}' },
      }),
      sse('content_block_stop', { index: 0 }),
      sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      sse('message_stop'),
    ].join('');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(modelResponse());
  });
  try {
    await writeFile(join(workspace, 'example.txt'), 'Example content.');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const run = extraArgs => new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        cliPath, '--print', 'Check the workspace',
        '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + address.port,
        '--model', 'local-incomplete-test', ...extraArgs,
      ], { env: { ...process.env, ANTHROPIC_API_KEY: 'local-test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.once('error', error => { clearTimeout(watchdog); rejectRun(error); });
      child.once('close', (code, signal) => {
        clearTimeout(watchdog);
        resolveRun({ code, signal, stdout, stderr });
      });
    });

    const truncated = await run(['--max-tokens', '4']);
    assert.equal(truncated.signal, null);
    assert.equal(truncated.code, 1, truncated.stderr);
    assert.equal(truncated.stdout.trim(), 'PARTIAL_ANSWER');
    assert.match(truncated.stderr, /reached --max-tokens before finishing/);
    assert.equal(requests.length, 1);

    fixture = 'max_turns';
    const exhausted = await run(['--max-turns', '1']);
    assert.equal(exhausted.signal, null);
    assert.equal(exhausted.code, 1, exhausted.stderr);
    assert.match(exhausted.stderr, /reached --max-turns \(1\) without a final response/);
    assert.equal(requests.length, 2, 'the agent must stop after the configured one model round');
    assert.equal(requests[1].tools.some(tool => tool.name === 'Read'), true);
    assert.equal(requests[1].max_tokens, 4096);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('CLI propagates HTTP 429 and 503 model errors with a nonzero exit status', {
  timeout: 20000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-http-errors-'));
  let status = 429;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume request */ }
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ error: {
      type: status === 429 ? 'rate_limit_error' : 'overloaded_error',
      message: status === 429 ? 'Too many requests.' : 'Service unavailable.',
    } }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    for (const expected of [429, 503]) {
      status = expected;
      const output = await new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, [
          cliPath, '--print', 'hello', '--cwd', workspace,
          '--base-url', 'http://127.0.0.1:' + addr.port,
          '--max-retries', '0',
        ], { env: { ...process.env, ANTHROPIC_API_KEY: 'not-for-logs' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const watchdog = setTimeout(() => child.kill('SIGKILL'), 7000);
        child.once('error', error => { clearTimeout(watchdog); rejectRun(error); });
        child.once('close', (code, signal) => {
          clearTimeout(watchdog);
          resolveRun({ code, signal, stdout, stderr });
        });
      });
      assert.equal(output.signal, null);
      assert.equal(output.code, 1, output.stderr);
      assert.match(output.stderr, new RegExp('HTTP ' + expected));
      assert.equal(output.stderr.includes('not-for-logs'), false);
      assert.equal(output.stdout.trim(), '');
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('CLI retries transient HTTP 503 once and then prints the streamed answer', {
  timeout: 15000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-retry-cli-'));
  const requests = [];
  const sse = (type, fields = {}) =>
    'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const success = [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'RETRY_WORKED' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 1) {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { type: 'overloaded_error', message: 'Try again.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(success);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        cliPath, '--print', 'hello', '--cwd', workspace,
        '--base-url', 'http://127.0.0.1:' + address.port,
        '--max-retries=1',
      ], {
        env: { ...process.env, ANTHROPIC_API_KEY: 'local-test-key' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.once('error', error => { clearTimeout(watchdog); rejectRun(error); });
      child.once('close', (code, signal) => {
        clearTimeout(watchdog);
        resolveRun({ code, signal, stdout, stderr });
      });
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'RETRY_WORKED');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('CLI --allow-edits executes workspace Write/Edit but still denies Bash and path escape', {
  timeout: 20000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-headless-edits-'));
  const escapeFile = join(workspace, '..', workspace.split(/[\\/]/).at(-1) + '-escaped.txt');
  const requests = [];
  const sse = (type, fields = {}) =>
    'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...fields }) + '\n\n';
  const toolStream = (id, name, input) => [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', { index: 0, delta: {
      type: 'input_json_delta', partial_json: JSON.stringify(input),
    } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sse('message_stop'),
  ].join('');
  const finalStream = [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Finished.' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const responses = [
    toolStream('headless-write', 'Write', { file_path: 'allowed.txt', content: 'before' }),
    toolStream('headless-edit', 'Edit', {
      file_path: 'allowed.txt', old_string: 'before', new_string: 'after',
    }),
    toolStream('headless-bash', 'Bash', {
      command: 'touch forbidden-by-default.txt',
    }),
    toolStream('headless-escape', 'Write', {
      file_path: '../' + escapeFile.split(/[\\/]/).at(-1), content: 'escape denied',
    }),
    finalStream,
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.end(responses[Math.min(requests.length - 1, responses.length - 1)]);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [
        cliPath, '--print', '--allow-edits', 'Update the file',
        '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + address.port,
        '--max-retries', '0',
      ], {
        env: { ...process.env, ANTHROPIC_API_KEY: 'test-key' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.once('error', error => { clearTimeout(watchdog); rejectRun(error); });
      child.once('close', (code, signal) => {
        clearTimeout(watchdog);
        resolveRun({ code, signal, stdout, stderr });
      });
    });
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'Finished.');
    assert.equal(await readFile(join(workspace, 'allowed.txt'), 'utf8'), 'after');
    await assert.rejects(readFile(join(workspace, 'forbidden-by-default.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(escapeFile), { code: 'ENOENT' });
    assert.equal(requests.length, 5);
    assert.match(result.stderr, /auto-approved Write/);
    assert.match(result.stderr, /auto-approved Edit/);
    assert.match(result.stderr, /denied Bash/);

    const toolResult = index => requests[index].messages.at(-1).content[0];
    assert.equal(toolResult(1).is_error, undefined, 'Write should succeed');
    assert.equal(toolResult(2).is_error, undefined, 'Edit should succeed');
    assert.equal(toolResult(3).is_error, true, 'Bash stays denied');
    assert.equal(toolResult(4).is_error, true, 'workspace escape stays denied');
    assert.match(toolResult(4).content, /File target is not authorized/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
    await rm(escapeFile, { force: true });
  }
});

test('Read offset/limit selects lines from files larger than the whole-file cap', {
  timeout: 15000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-read-lines-'));
  try {
    const repeated = 'skip\n'.repeat(230000);
    await writeFile(join(workspace, 'large.txt'), repeated + 'TARGET α\nTAIL\n');
    await writeFile(join(workspace, 'small.txt'), 'first\r\nsecond\r\nthird');
    await writeFile(join(workspace, 'binary.txt'), Buffer.from([65, 0, 66, 10]));
    const tools = await createBuiltinTools({ workspace });
    const read = tools.get('Read');

    await assert.rejects(
      read.execute({ file_path: 'large.txt' }),
      /File exceeds the 1 MiB read limit/,
    );
    assert.equal(
      await read.execute({ file_path: 'large.txt', offset: 230000, limit: 1 }),
      'TARGET α\n',
    );
    assert.equal(
      await read.execute({ file_path: 'large.txt', offset: 230001, limit: 1 }),
      'TAIL\n',
    );
    assert.equal(
      await read.execute({ file_path: 'small.txt', offset: 1, limit: 2 }),
      'second\r\nthird',
    );
    assert.equal(await read.execute({ file_path: 'small.txt', offset: 4, limit: 1 }), '');
    assert.equal(await read.execute({ file_path: 'small.txt', limit: 1 }), 'first\r\n');
    assert.equal(await read.execute({ file_path: 'small.txt' }), 'first\r\nsecond\r\nthird');

    await assert.rejects(read.execute({ file_path: 'binary.txt', limit: 1 }), /binary file/);
    await assert.rejects(
      read.execute({ file_path: 'large.txt', offset: 0, limit: 230001 }),
      /Selected lines exceed the 1 MiB read limit/,
    );
    assert.match((await tools.validateInput('Read', { file_path: 'small.txt', offset: -1 })).join(' '), /minimum/);
    assert.match((await tools.validateInput('Read', { file_path: 'small.txt', limit: 0 })).join(' '), /minimum/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('npm-style symlink executable invokes CLI main rather than exiting silently', {
  skip: process.platform === 'win32',
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-cil-symlink-bin-'));
  try {
    const target = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const linkPath = join(folder, 'agent-cil');
    await symlink(target, linkPath);
    const run = spawnSync(linkPath, ['--version'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'agent-cil 0.1.0\n');
    assert.equal(run.stderr, '');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});


test('ported legacy acceptEdits mode is the active CLI policy without bypassing Bash or path validation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-legacy-mode-'));
  try {
    const defaultContext = createCliPermissionContext();
    const editContext = createCliPermissionContext({ allowEdits: true });
    assert.equal(defaultContext.mode, 'default');
    assert.equal(editContext.mode, 'acceptEdits');

    const normal = createCliPermissionPolicy({ workspace, permissionContext: defaultContext });
    const edits = createCliPermissionPolicy({ workspace, permissionContext: editContext });

    assert.equal((await normal({ name: 'Write', input: { file_path: 'safe.txt' } })).behavior, 'ask');
    assert.equal((await edits({ name: 'Write', input: { file_path: 'safe.txt' } })).behavior, 'allow');
    assert.equal((await edits({ name: 'Edit', input: { file_path: 'safe.txt' } })).behavior, 'allow');
    assert.equal((await edits({ name: 'Bash', input: { command: 'echo hi' } })).behavior, 'ask');

    const escaped = await edits({ name: 'Write', input: { file_path: '../outside.txt' } });
    assert.equal(escaped.behavior, 'deny');
    assert.match(escaped.reason, /escapes the workspace/);
    assert.equal((await edits({ name: 'Read', input: { file_path: 'safe.txt' } })).behavior, 'allow');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});


test('ported 2.1.88 whole-tool rules drive actual CLI policy after file safety checks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-legacy-rules-'));
  try {
    const base = createCliPermissionContext({ allowEdits: true });
    const rules = applyPermissionUpdates(base, [
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [
        { toolName: 'Bash' }, { toolName: 'Write' },
      ] },
      { type: 'addRules', behavior: 'ask', destination: 'session', rules: [
        { toolName: 'Write' },
      ] },
      { type: 'addRules', behavior: 'deny', destination: 'projectSettings', rules: [
        { toolName: 'Edit' },
      ] },
    ]);
    const policy = createCliPermissionPolicy({ workspace, permissionContext: rules });
    assert.equal((await policy({ name: 'Write', input: { file_path: 'safe.txt' } })).behavior, 'ask',
      'ask rule overrides allow and acceptEdits mode');
    assert.equal((await policy({ name: 'Edit', input: { file_path: 'safe.txt' } })).behavior, 'deny',
      'explicit deny overrides acceptEdits mode');
    assert.equal((await policy({ name: 'Bash', input: { command: 'echo hi' } })).behavior, 'allow',
      'explicit user-owned whole-tool allow rule is evaluated');
    assert.equal((await policy({ name: 'Read', input: { file_path: 'safe.txt' } })).behavior, 'allow');

    for (const name of ['Read', 'Write', 'Edit']) {
      const escaped = await policy({ name, input: { file_path: '../escape.txt' } });
      assert.equal(escaped.behavior, 'deny', 'rule must never override path escape for ' + name);
      assert.match(escaped.reason, /File target is not authorized/);
    }
    const invalidGlob = await policy({ name: 'Glob', input: { pattern: '../*.js' } });
    assert.equal(invalidGlob.behavior, 'deny');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('ported whole-tool deny still blocks executed Write when AgentLoop rechecks replaced input', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-legacy-recheck-'));
  try {
    const rules = applyPermissionUpdates(createCliPermissionContext({ allowEdits: true }), [
      { type: 'addRules', behavior: 'deny', destination: 'session',
        rules: [{ toolName: 'Write' }] },
    ]);
    const policy = createCliPermissionPolicy({ workspace, permissionContext: rules });
    const tools = await createBuiltinTools({ workspace });
    let asked = 0;
    const model = { async *stream({ messages }) {
      if (messages.length === 1) {
        yield { type: 'tool_use', id: 'deny-write', name: 'Write',
          input: { file_path: 'denied.txt', content: 'must not be written' } };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } else {
        const block = messages.at(-1).content[0];
        assert.equal(block.tool_use_id, 'deny-write');
        assert.equal(block.is_error, true);
        assert.match(block.content, /Permission to use Write has been denied/);
        yield { type: 'text_delta', text: 'denied correctly' };
        yield { type: 'message_end', stopReason: 'end_turn' };
      }
    } };
    const loop = new AgentLoop({
      model, tools, permissionPolicy: policy,
      approvalHandler: async () => { asked += 1; return { approved: true }; },
    });
    const output = await loop.run({ input: 'try to write' });
    assert.equal(output.stopReason, 'end_turn');
    assert.equal(asked, 0, 'deny rules must not request approval');
    await assert.rejects(readFile(join(workspace, 'denied.txt')), { code: 'ENOENT' });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
