import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const sse = (type, data = {}) => 'event: ' + type + '\n' +
  'data: ' + JSON.stringify({ type, ...data }) + '\n\n';

test('CLI follows 2.1.88 query when real SSE tool_use disagrees with stop_reason', {
  timeout: 16000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-query-sse-'));
  const fixture = join(workspace, 'proof.txt');
  const requests = [];
  const first = [
    sse('message_start', { message: { usage: { input_tokens: 3 } } }),
    sse('content_block_start', { index: 0, content_block: {
      type: 'tool_use', id: 'read-from-query', name: 'Read', input: {},
    } }),
    sse('content_block_delta', { index: 0, delta: {
      type: 'input_json_delta', partial_json: '{"file_path":"proof.txt"}',
    } }),
    sse('content_block_stop', { index: 0 }),
    // Old query.ts explicitly calls stop_reason unreliable for tool_use.
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const second = [
    sse('message_start', { message: { usage: { input_tokens: 3 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: {
      type: 'text_delta', text: 'Read completed through legacy query.',
    } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const server = createServer(async (request, response) => {
    const data = [];
    for await (const chunk of request) data.push(chunk);
    requests.push(JSON.parse(Buffer.concat(data).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.end(requests.length === 1 ? first : second);
  });
  let child;
  let timeout;
  try {
    await writeFile(fixture, 'actual workspace content\n');
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    child = spawn(process.execPath, [
      cli, '--print', '--max-retries', '0', '--max-turns', '3',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + addr.port,
      '--model', 'old-query-behavior-fixture',
      'Read proof.txt.',
    ], { env: { ...process.env, ANTHROPIC_API_KEY: 'local-fixture' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    const [code, sig] = await new Promise((resolveClose, rejectClose) => {
      child.once('error', rejectClose);
      child.once('close', (exit, signal) => resolveClose([exit, signal]));
    });
    assert.equal(sig, null, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'Read completed through legacy query.');
    assert.equal(requests.length, 2);
    const results = requests[1].messages.at(-1).content;
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_use_id, 'read-from-query');
    assert.equal(results[0].content, 'actual workspace content\n');
    assert.equal(await readFile(fixture, 'utf8'), 'actual workspace content\n');
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    await rm(workspace, { recursive: true, force: true });
  }
});
