import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const verificationScript = fileURLToPath(new URL('../../../scripts/verify-live-provider.mjs', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/index.js', import.meta.url));

function sse(type, data = {}) {
  return 'event: ' + type + '\n' + 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';
}
function textReply(text) {
  return [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
}
function toolReply(id, name, input) {
  return [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', { index: 0, content_block: {
      type: 'tool_use', id, name, input: {},
    } }),
    sse('content_block_delta', { index: 0, delta: {
      type: 'input_json_delta', partial_json: JSON.stringify(input),
    } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sse('message_stop'),
  ].join('');
}

// Exercise the exact optional live acceptance script, but use a local SSE
// fixture with a fake key. It verifies a .js CLI entrypoint is launched with
// Node (rather than executed directly, which raises EFTYPE on Windows).
// The script itself validates actual Read -> Edit -> Read filesystem changes.
test('live-provider harness launches .js CLI through Node on Windows and POSIX', {
  timeout: 45000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-launch-fixture-'));
  const requests = [];
  const responses = [
    textReply('READY'),
    toolReply('read-before', 'Read', { file_path: 'math.js' }),
    toolReply('edit-code', 'Edit', {
      file_path: 'math.js', old_string: 'return a - b;',
      new_string: 'return a + b;',
    }),
    toolReply('read-after', 'Read', { file_path: 'math.js' }),
    textReply('fixed'),
  ];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(responses[requests.length - 1] ?? textReply('unexpected'));
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
    child = spawn(process.execPath, [verificationScript, cliEntry], {
      cwd: workspace,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'local-acceptance-fixture-key',
        ANTHROPIC_MODEL: 'deepseek-flash',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + address.port + '/anthropic',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 30000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, errors);
    assert.equal(status, 0, errors);
    assert.match(output, /PASS: credentialed streaming response/);
    assert.match(output, /PASS: live Read -> Edit -> Read coding task/);
    assert.equal(requests.length, 5, 'both live-harness runs should complete');
    assert.equal(requests[0].model, 'deepseek-flash');
    assert.equal(requests[2].messages.at(-1).content[0].tool_use_id, 'read-before');
    assert.equal(requests[3].messages.at(-1).content[0].tool_use_id, 'edit-code');
    assert.equal(requests[4].messages.at(-1).content[0].tool_use_id, 'read-after');
    assert.equal(output.includes('local-acceptance-fixture-key'), false);
    assert.equal(errors.includes('local-acceptance-fixture-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
