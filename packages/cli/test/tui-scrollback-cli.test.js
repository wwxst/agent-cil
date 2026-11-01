import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeTuiOutput } from './tui-test-helpers.js';

// This test also runs against the npm-pack-installed CLI executable.
const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const event = (type, payload = {}) =>
  'event: ' + type + '\\ndata: ' + JSON.stringify({ type, ...payload }) + '\\n\\n';
const finishStream = text => [
  event('message_start', { message: { usage: { input_tokens: 2 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  event('content_block_stop', { index: 0 }),
  event('message_delta', { delta: { stop_reason: 'end_turn' } }),
  event('message_stop'),
].join('');
const pad = value => String(value).padStart(2, '0');

test('original 2.1.88 ScrollBox keeps older interactive turns reachable with PageUp', {
  timeout: 35000,
  skip: process.platform === 'win32' &&
    'util-linux script PTY is Linux-only; Windows ConPTY input remains covered by the native approval tests',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-scrollback-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(finishStream('reply-' + pad(calls.length)));
  });

  let child;
  let watchdog;
  let pageUpTimer;
  let output = '';
  let stderr = '';
  let sentPrompts = 0;
  let pageUpStarted = false;
  let pageUpStart = -1;
  let pageUpCount = 0;
  let exitSent = false;
  const totalTurns = 12;

  const sendPageUp = () => {
    if (pageUpCount >= 8 || exitSent) return;
    child.stdin.write('\\x1b[5~');
    pageUpCount += 1;
    pageUpTimer = setTimeout(sendPageUp, 90);
  };

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint === 'object');

    const args = [
      process.execPath, cli, '--max-retries', '0', '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + endpoint.port,
      '--model', 'scrollback-tty-fixture',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = 'stty rows 24 cols 100; ' + args.map(quote).join(' ');
    child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'scrollback-tty-key',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        COLUMNS: '100',
        LINES: '24',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);

      if (sentPrompts === 0 && visible.includes('you> ')) {
        sentPrompts = 1;
        child.stdin.write('prompt-01\\r');
        return;
      }

      if (sentPrompts > 0 && sentPrompts < totalTurns &&
          visible.includes('reply-' + pad(sentPrompts)) && visible.includes('you> ')) {
        sentPrompts += 1;
        child.stdin.write('prompt-' + pad(sentPrompts) + '\\r');
        return;
      }

      if (sentPrompts === totalTurns && !pageUpStarted &&
          visible.includes('reply-' + pad(totalTurns)) && visible.includes('you> ')) {
        pageUpStarted = true;
        pageUpStart = output.length;
        sendPageUp();
        return;
      }

      if (pageUpStarted && !exitSent &&
          normalizeTuiOutput(output.slice(pageUpStart)).includes('reply-01')) {
        exitSent = true;
        if (pageUpTimer) clearTimeout(pageUpTimer);
        child.stdin.write('/exit\\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 30000);

    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });

    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(sentPrompts, totalTurns, stderr + output);
    assert.ok(pageUpStarted, 'PageUp sequence was not sent: ' + stderr + output);
    assert.ok(pageUpCount > 0, 'no PageUp keypresses were sent');
    assert.ok(exitSent, 'the first turn did not become visible after PageUp: ' + stderr + output);
    assert.equal(calls.length, totalTurns, stderr + output);
    assert.doesNotMatch(output + stderr,
      /Could not start the original Ink TUI|falling back to the readline interface/);
  } finally {
    if (pageUpTimer) clearTimeout(pageUpTimer);
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
