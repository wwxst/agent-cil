import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Acceptance test for an installed npm tarball, not a checkout source path.
// The endpoint is a local deterministic SSE fixture, not a real model.
const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/verify-installed-cli.mjs <installed binary>');
const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-installed-smoke-'));
const requests = [];
const sse = (type, data = {}) =>
  'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';
const toolReply = [
  sse('message_start', { message: { usage: { input_tokens: 2 } } }),
  sse('content_block_start', { index: 0, content_block: {
    type: 'tool_use', id: 'installed-read', name: 'Read', input: {},
  } }),
  sse('content_block_delta', { index: 0, delta: {
    type: 'input_json_delta', partial_json: '{"file_path":"smoke.txt"}',
  } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
  sse('message_stop'),
].join('');
const answer = [
  sse('message_start', { message: { usage: { input_tokens: 2 } } }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: {
    type: 'text_delta', text: 'Installed CLI verified the file.',
  } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
  sse('message_stop'),
].join('');
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  response.end(requests.length === 1 ? toolReply : answer);
});
let child;
let timer;
try {
  await writeFile(join(workspace, 'smoke.txt'), 'packed runtime exists\n');
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  child = spawn(resolve(executable), [
    '--print', '--cwd', workspace, '--max-retries', '0',
    '--base-url', 'http://127.0.0.1:' + address.port,
    '--model', 'installed-fixture', 'Read the smoke file',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ANTHROPIC_API_KEY: 'installed-fixture-key' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [exitCode, signal] = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, sig) => resolveExit([code, sig]));
  });

  assert.equal(signal, null, stderr);
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout.trim(), 'Installed CLI verified the file.');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, 'user');
  assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, 'installed-read');
  assert.equal(requests[1].messages.at(-1).content[0].content, 'packed runtime exists\n');
  assert.equal(await readFile(join(workspace, 'smoke.txt'), 'utf8'), 'packed runtime exists\n');
  assert.equal(stderr.includes('installed-fixture-key'), false);
  process.stdout.write('Installed tarball smoke: CLI start, local SSE, Read, tool_result, exit 0.\n');
} finally {
  if (timer) clearTimeout(timer);
  if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
  server.closeAllConnections?.();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(workspace, { recursive: true, force: true });
}
