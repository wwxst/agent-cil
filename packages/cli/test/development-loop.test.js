import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function sse(type, fields = {}) {
  return 'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...fields }) + '\n\n';
}

function toolResponse(id, name, input) {
  return [
    sse('message_start', { message: { usage: { input_tokens: 5 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
    sse('message_stop'),
  ].join('');
}

function finalResponse(text) {
  return [
    sse('message_start', { message: { usage: { input_tokens: 5 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    sse('message_stop'),
  ].join('');
}

function lastToolResult(request, toolUseId) {
  const matching = request.messages.flatMap(message =>
    message.role === 'user' && Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)
      : []);
  assert.equal(matching.length, 1, 'expected exactly one matching tool_result for ' + toolUseId);
  return matching[0];
}

test('real CLI subprocess locates code, recovers from a failed edit, and verifies the fix', {
  timeout: 20000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-development-task-'));
  const filePath = join(workspace, 'src', 'math.js');
  const original = 'export function add(a, b) {\n  return a - b;\n}\n';
  const fixed = 'export function add(a, b) {\n  return a + b;\n}\n';
  const otherPath = join(workspace, 'src', 'untouched.js');
  const responses = [
    toolResponse('find-js', 'Glob', { pattern: 'src/*.js' }),
    toolResponse('read-old', 'Read', { file_path: 'src/math.js' }),
    toolResponse('bad-edit', 'Edit', {
      file_path: 'src/math.js',
      old_string: 'return a * b;',
      new_string: 'return a + b;',
    }),
    toolResponse('good-edit', 'Edit', {
      file_path: 'src/math.js',
      old_string: 'return a - b;',
      new_string: 'return a + b;',
    }),
    toolResponse('read-new', 'Read', { file_path: 'src/math.js' }),
    finalResponse('Verified that add now performs addition.'),
  ];
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const index = requests.length - 1;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
    response.end(responses[index] ?? finalResponse('Unexpected extra model request'));
  });
  let child;
  let watchdog;
  try {
    await mkdir(join(workspace, 'src'));
    await writeFile(filePath, original);
    await writeFile(otherPath, 'export const untouched = true;\n');

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    child = spawn(process.execPath, [
      cliPath,
      '--print',
      '--allow-edits',
      '--max-turns', '8',
      '--max-retries', '0',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + address.port,
      '--model', 'local-development-task-fixture',
      'Find the implementation of add, fix its arithmetic, and verify by rereading.',
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-credential' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [exitCode, exitSignal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });

    assert.equal(exitSignal, null, stderr);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stdout.trim(), 'Verified that add now performs addition.');
    assert.equal(requests.length, responses.length, 'exactly six model rounds are needed');
    assert.equal(await readFile(filePath, 'utf8'), fixed);
    assert.equal(await readFile(otherPath, 'utf8'), 'export const untouched = true;\n');

    assert.deepEqual(JSON.parse(lastToolResult(requests[1], 'find-js').content).matches,
      ['src/math.js', 'src/untouched.js']);
    assert.equal(lastToolResult(requests[2], 'read-old').content, original);
    const badResult = lastToolResult(requests[3], 'bad-edit');
    assert.equal(badResult.is_error, true);
    assert.match(badResult.content, /old_string was not found/);
    assert.equal(lastToolResult(requests[4], 'good-edit').is_error, undefined);
    assert.equal(lastToolResult(requests[5], 'read-new').content, fixed);

    assert.match(stderr, /auto-approved Edit/);
    assert.equal(stderr.includes('fixture-credential'), false);
    assert.ok(requests[5].messages.some(message =>
      message.role === 'assistant' && Array.isArray(message.content) &&
      message.content.some(block => block.type === 'tool_use' && block.id === 'read-new')),
    'the last request must retain earlier assistant tool calls');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
