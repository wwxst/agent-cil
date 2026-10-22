import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  CliArgumentError,
  createBuiltinTools,
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

test('parses model, endpoint, token, system, cwd, print and prompt options', () => {
  const options = parseArgs([
    '--print',
    '--model', 'claude-test-model',
    '--base-url=https://example.test',
    '--max-tokens', '2048',
    '--system', 'Be precise.',
    '--cwd', '/tmp/project',
    'explain', 'this repository',
  ]);
  assert.equal(options.print, true);
  assert.equal(options.model, 'claude-test-model');
  assert.equal(options.baseUrl, 'https://example.test');
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.system, 'Be precise.');
  assert.equal(options.cwd, resolve('/tmp/project'));
  assert.equal(options.prompt, 'explain this repository');
});

test('rejects unknown options and invalid max token values', () => {
  assert.throws(() => parseArgs(['--unknown']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-tokens', '0']), CliArgumentError);
  assert.throws(() => parseArgs(['--model']), CliArgumentError);
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

    assert.equal((await policy({ name: 'Read', input: { file_path: 'linked.txt' } })).behavior, 'allow');
    assert.equal((await policy({ name: 'Write', input: { file_path: 'safe/new.txt' } })).behavior, 'ask');
    assert.equal((await policy({ name: 'Edit', input: { file_path: 'safe/new.txt' } })).behavior, 'ask');

    const traversal = await policy({ name: 'Write', input: { file_path: '../outside.txt' } });
    assert.equal(traversal.behavior, 'deny');
    assert.match(traversal.reason, /escapes the workspace/);

    const symlinkWrite = await policy({ name: 'Write', input: { file_path: 'linked.txt' } });
    assert.equal(symlinkWrite.behavior, 'deny');
    assert.match(symlinkWrite.reason, /Symbolic links are not allowed/);

    assert.equal((await policy({ name: 'Bash', input: { command: 'echo hello' } })).behavior, 'ask');
    assert.equal((await policy({ name: 'unexpected', input: {} })).behavior, 'deny');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('built-in tools provide read, write and unique-match edit operations', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-cli-'));
  try {
    const tools = await createBuiltinTools({ workspace });
    assert.deepEqual(tools.list().map((tool) => tool.name), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);

    await tools.get('Write').execute({ file_path: 'src/example.js', content: 'const value = 1;\n' });
    assert.equal(await tools.get('Read').execute({ file_path: 'src/example.js' }), 'const value = 1;\n');

    await tools.get('Edit').execute({
      file_path: 'src/example.js',
      old_string: 'value = 1',
      new_string: 'value = 2',
    });
    assert.equal(await readFile(join(workspace, 'src/example.js'), 'utf8'), 'const value = 2;\n');

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
