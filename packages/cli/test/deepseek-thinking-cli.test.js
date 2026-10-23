import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const sse = (type, payload = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n';
const start = () => sse('message_start', { message: { usage: { input_tokens: 3 } } });
const block = (index, content_block) => sse('content_block_start', { index, content_block });
const delta = (index, data) => sse('content_block_delta', { index, delta: data });
const stop = index => sse('content_block_stop', { index });
const end = reason => sse('message_delta', { delta: { stop_reason: reason } }) + sse('message_stop');

test('real DeepSeek-compatible CLI subprocess handles thinking + Read + Edit + signed replay', {
  timeout: 18000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-thinking-'));
  const first = start() +
    block(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'This content must stay private.' }) +
    delta(0, { type: 'signature_delta', signature: 'opaque-signed-first' }) + stop(0) +
    block(1, { type: 'tool_use', id: 'read-file', name: 'Read', input: {} }) +
    delta(1, { type: 'input_json_delta', partial_json: '{"file_path":"math.js"}' }) +
    stop(1) + end('tool_use');
  const second = start() +
    block(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'Still private.' }) +
    delta(0, { type: 'signature_delta', signature: 'opaque-signed-second' }) + stop(0) +
    block(1, { type: 'tool_use', id: 'edit-file', name: 'Edit', input: {} }) +
    delta(1, { type: 'input_json_delta',
      partial_json: '{"file_path":"math.js","old_string":"a - b","new_string":"a + b"}' }) +
    stop(1) + end('tool_use');
  const third = start() +
    block(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'Not user-visible either.' }) + stop(0) +
    block(1, { type: 'text', text: '' }) +
    delta(1, { type: 'text_delta', text: 'Fixed the file.' }) +
    stop(1) + end('end_turn');
  const received = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const piece of req) parts.push(piece);
    received.push({ url: req.url, data: JSON.parse(Buffer.concat(parts).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([first, second, third][received.length - 1] ?? third);
  });
  let child;
  let watchdog;
  try {
    await writeFile(join(workspace, 'math.js'), 'const add = (a,b) => a - b;\n');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const a = server.address();
    child = spawn(process.execPath, [
      cli, '--print', '--allow-edits', '--model', 'deepseek-flash',
      '--base-url', 'http://127.0.0.1:' + a.port + '/anthropic',
      '--cwd', workspace, '--max-retries', '0',
      'Read and fix math.js.',
    ], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTHROPIC_API_KEY: 'local-fixture-secret' } });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', x => { output += x; });
    child.stderr.on('data', x => { errors += x; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, errors);
    assert.equal(status, 0, errors);
    assert.equal(output.trim(), 'Fixed the file.');
    assert.equal(output.includes('private'), false);
    assert.equal(errors.includes('private'), false);
    assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'),
      'const add = (a,b) => a + b;\n');
    assert.equal(received.length, 3);
    assert.deepEqual(received[1].data.messages[1].content, [
      { type: 'thinking', thinking: 'This content must stay private.',
        signature: 'opaque-signed-first' },
      { type: 'tool_use', id: 'read-file', name: 'Read', input: { file_path: 'math.js' } },
    ]);
    assert.equal(received[1].data.messages.at(-1).content[0].content,
      'const add = (a,b) => a - b;\n');
    assert.deepEqual(received[2].data.messages[3].content[0], {
      type: 'thinking', thinking: 'Still private.',
      signature: 'opaque-signed-second',
    });
    assert.equal(received[2].data.messages.at(-1).content[0].tool_use_id, 'edit-file');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
