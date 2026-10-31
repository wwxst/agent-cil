import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalizeTuiOutput } from './tui-test-helpers.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const sse = (type, value = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n';
const tool = (id, name, input) => [
  sse('message_start', { message: { usage: { input_tokens: 3 } } }),
  sse('content_block_start', { index: 0,
    content_block: { type: 'tool_use', id, name, input: {} } }),
  sse('content_block_delta', { index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
  sse('message_stop'),
].join('');
const final = text => [
  sse('message_start', { message: { usage: { input_tokens: 3 } } }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
  sse('message_stop'),
].join('');

async function waitUntil(predicate, timeoutMs, description, getOutput) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for ' + description + ':\n' + getOutput());
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function waitForExit(exitPromise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    exitPromise.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function startConpty({ workspace, port, prompt }) {
  const { spawn: spawnPty } = await import('node-pty').then(module =>
    module.default ?? module,
  );
  assert.equal(typeof spawnPty, 'function',
    'node-pty must be installed by the Windows ConPTY CI job');
  const terminal = spawnPty(process.execPath, [
    cli, '--provider', 'deepseek', '--max-retries', '0',
    '--cwd', workspace,
    '--base-url', 'http://127.0.0.1:' + port + '/anthropic',
    ...(prompt ? [prompt] : []),
  ], {
    name: 'xterm-256color',
    cols: 110,
    rows: 32,
    cwd: workspace,
    useConpty: true,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      DEEPSEEK_API_KEY: 'fixture-windows-permission-key',
    },
  });
  let output = '';
  let didExit = false;
  const exitPromise = new Promise(resolve => {
    terminal.onExit(info => {
      didExit = true;
      resolve(info);
    });
  });
  terminal.onData(data => { output += data; });
  return {
    terminal,
    exitPromise,
    get output() { return output; },
    get didExit() { return didExit; },
  };
}

async function disposeTerminal(session) {
  if (!session) return;
  if (!session.didExit) {
    try { process.kill(session.terminal.pid); } catch {}
  }
  try { session.terminal.kill(); } catch {}
  if (!session.didExit) await waitForExit(session.exitPromise, 2000);
}

test('Windows ConPTY: defaultToNo hides indexes and ignores numeric/Y shortcuts before Deny', {
  timeout: 30000,
  skip: process.platform !== 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-conpty-default-to-no-'));
  const marker = join(workspace, 'must-not-run.txt');
  const command = `node -e "require('fs').writeFileSync('must-not-run.txt','executed')"`;
  const requests = [];
  const server = createServer();
  server.on('request', async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(requests.length === 1
      ? tool('windows-default-to-no', 'Bash', { command })
      : final('Denied safely by defaultToNo on Windows.'));
  });
  let session;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    session = await startConpty({
      workspace, port: server.address().port,
      prompt: 'Please run the requested shell command.',
    });
    await waitUntil(() => normalizeTuiOutput(session.output).includes('Permission required'),
      10000, 'the real Bash permission prompt', () => session.output);
    const permissionPromptSnapshot = normalizeTuiOutput(session.output).slice(
      normalizeTuiOutput(session.output).indexOf('Permission required'),
    );
    assert.doesNotMatch(permissionPromptSnapshot, /\b[1-3]\.\s/,
      'defaultToNo must hide the option indexes');
    // The original 2.1.304 defaultToNo Select hides indexes and disables
    // numeric shortcuts. A stray full-width digit and Y must not approve.
    session.terminal.write('２');
    await new Promise(resolve => setTimeout(resolve, 220));
    session.terminal.write('y');
    await new Promise(resolve => setTimeout(resolve, 220));
    session.terminal.write('\r');
    await waitUntil(
      () => normalizeTuiOutput(session.output).includes('Denied safely by defaultToNo on Windows.') &&
        normalizeTuiOutput(session.output).includes('you>'),
      10000, 'the response and resumed input prompt', () => session.output,
    );
    session.terminal.write('/exit\r');
    const exit = await waitForExit(session.exitPromise, 5000);
    assert.ok(exit, session.output);
    assert.equal(exit.exitCode, 0, session.output);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    assert.equal(requests.length, 2);
    const result = requests[1].messages.at(-1).content[0];
    assert.equal(result.tool_use_id, 'windows-default-to-no');
    assert.equal(result.is_error, true, JSON.stringify(result));
    assert.doesNotMatch(session.output,
      /Could not start the original Ink TUI|falling back to the readline interface/);
  } finally {
    await disposeTerminal(session);
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});
