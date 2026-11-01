import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTerminalScreen } from './tui-test-helpers.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const event = (type, payload = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n';
const markdown = [
  '# Build status',
  '',
  '**Done**: `agent-cil`.',
  '',
  '- Markdown list item',
  '- Second item',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '| tool | status |',
  '| --- | --- |',
  '| Read | ok |',
].join('\n');
const finishStream = text => [
  event('message_start', { message: { usage: { input_tokens: 2 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  event('content_block_stop', { index: 0 }),
  event('message_delta', { delta: { stop_reason: 'end_turn' } }),
  event('message_stop'),
].join('');

test('installed Ink TUI renders completed assistant messages with original 2.1.88 Markdown', {
  timeout: 25000,
  skip: process.platform === 'win32' &&
    'util-linux script PTY is Linux-only; Windows native ConPTY remains covered by the approval tests',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-markdown-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(finishStream(markdown));
  });

  let child;
  let watchdog;
  let sentExit = false;
  let output = '';
  let stderr = '';
  const terminalScreen = createTerminalScreen(80, 24);

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
      '--model', 'markdown-tty-fixture', 'Render this Markdown response.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = 'stty rows 24 cols 80; ' + args.map(quote).join(' ');
    child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'markdown-tty-key',
        LANG: 'en_US.UTF-8',
        TERM: 'xterm-256color',
        COLUMNS: '80',
        LINES: '24',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      terminalScreen.write(chunk);
      const visible = terminalScreen.toString();
      if (!sentExit &&
          visible.includes('Build status') &&
          visible.includes('Markdown list item') &&
          visible.includes('const answer = 42;') &&
          visible.includes('you> ')) {
        sentExit = true;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 20000);

    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    const visible = terminalScreen.toString();
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(calls.length, 1, stderr + output);
    assert.equal(sentExit, true, 'completed Markdown and the next prompt must be visible: ' + visible);
    assert.match(visible, /Build status/);
    assert.match(visible, /Done/);
    assert.match(visible, /Markdown list item/);
    assert.match(visible, /const answer = 42;/);
    assert.match(visible, /tool/);
    assert.match(visible, /status/);
    assert.doesNotMatch(visible, /\*\*Done\*\*/);
    assert.doesNotMatch(visible, /```/);
    assert.doesNotMatch(output + stderr,
      /Could not start the original Ink TUI|falling back to the readline interface/);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
