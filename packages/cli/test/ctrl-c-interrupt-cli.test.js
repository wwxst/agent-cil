import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const sse = (type, value = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n';
function final(text) {
  return sse('message_start', { message: { usage: { input_tokens: 3 } } }) +
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    sse('content_block_stop', { index: 0 }) +
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }) +
    sse('message_stop');
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('TTY Ctrl+C aborts in-flight DeepSeek SSE, does not exit, and idle Ctrl+C needs two presses', {
  timeout: 26000,
  skip: process.platform === 'win32', // ConPTY covered by credentialed Windows acceptance.
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-ctrlc-'));
  const requests = [];
  let openStream;
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      openStream = res;
      res.write(sse('message_start', { message: { usage: { input_tokens: 3 } } }) +
        sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STREAMING' } }));
      // Keep the SSE socket open until the CLI's AbortController cancels it.
    } else res.end(final('RESUMED'));
  });
  let child, watchdog;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    child = spawn('script', ['-q', '-e', '-c', [
      process.execPath, cli, '--provider', 'deepseek', '--max-retries', '0',
      '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + port + '/anthropic',
      'Start a long response; do not call tools.',
    ].map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-ctrlc-test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', err = '';
    let sentBusyInterrupt = false, sentIdleInterrupt = false;
    let sentContinue = false, sentExit = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!sentBusyInterrupt && output.includes('STREAMING')) {
        sentBusyInterrupt = true;
        child.stdin.write('\x03');
      }
      if (sentBusyInterrupt && !sentIdleInterrupt &&
        output.includes('Interrupted.') && output.includes('you> ')) {
        sentIdleInterrupt = true;
        child.stdin.write('\x03');
      }
      if (sentIdleInterrupt && !sentContinue &&
        output.includes('Press Ctrl+C again to exit.')) {
        sentContinue = true;
        child.stdin.write('continue\n');
      }
      if (sentContinue && !sentExit && output.includes('RESUMED')) {
        sentExit = true;
        child.stdin.write('/exit\n');
      }
    });
    child.stderr.on('data', x => { err += x; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, output + err);
    assert.equal(status, 0, output + err);
    assert.equal(sentBusyInterrupt, true, output + err);
    assert.equal(sentIdleInterrupt, true, output + err);
    assert.equal(sentContinue, true, output + err);
    assert.equal(sentExit, true, output + err);
    assert.match(output, /Interrupted by user/);
    assert.match(output, /Press Ctrl\+C again to exit/);
    assert.match(output, /RESUMED/);
    assert.equal(requests.length, 2, 'cancelled partial SSE must not be replayed');
    assert.equal(output.includes('fixture-ctrlc-test-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (openStream && !openStream.destroyed) openStream.destroy();
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
