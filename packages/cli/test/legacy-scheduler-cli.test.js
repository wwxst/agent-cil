import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sse = (type, data = {}) => 'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';

test('installed CLI chain orders Read → Write → Read in one model tool-use turn', {
  timeout: 18000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-executor-parity-'));
  const file = join(workspace, 'value.txt');
  const requests = [];
  const toolUses = [
    ['before', 'Read', { file_path: 'value.txt' }],
    ['write', 'Write', { file_path: 'value.txt', content: 'after\n' }],
    ['after', 'Read', { file_path: 'value.txt' }],
  ];
  const first = [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    ...toolUses.flatMap(([id, name, input], index) => [
      sse('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }),
      sse('content_block_delta', { index, delta: {
        type: 'input_json_delta', partial_json: JSON.stringify(input),
      } }),
      sse('content_block_stop', { index }),
    ]),
    sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sse('message_stop'),
  ].join('');
  const last = [
    sse('message_start', { message: { usage: { input_tokens: 3 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'confirmed' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(requests.length === 1 ? first : last);
  });
  let child;
  let timer;
  try {
    await writeFile(file, 'before\n');
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    child = spawn(process.execPath, [
      fileURLToPath(new URL('../src/index.js', import.meta.url)),
      '--print', '--allow-edits', '--max-retries', '0',
      '--base-url', 'http://127.0.0.1:' + address.port,
      '--cwd', workspace, 'Read, change, read again',
    ], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    const [code, signal] = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (exit, sig) => done([exit, sig]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'confirmed');
    assert.equal(requests.length, 2);
    assert.equal(await readFile(file, 'utf8'), 'after\n');
    const results = requests[1].messages.at(-1).content;
    assert.deepEqual(results.map(block => block.tool_use_id), ['before', 'write', 'after']);
    assert.equal(results[0].content, 'before\n');
    assert.equal(results[2].content, 'after\n');
    assert.equal(results[1].is_error, undefined);
    assert.equal(JSON.parse(results[1].content).written, true);
    assert.match(stderr, /auto-approved Write/);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    await rm(workspace, { recursive: true, force: true });
  }
});
