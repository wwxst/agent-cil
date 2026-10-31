import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('Windows ConPTY: Bash Select ignores Y and Enter confirms default Deny', {
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

test('Windows ConPTY: exact Bash session grant applies before recheck and does not authorize another command', {
  timeout: 35000,
  skip: process.platform !== 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-conpty-session-grant-'));
  const firstMarker = join(workspace, 'same-command.txt');
  const secondMarker = join(workspace, 'different-command-must-not-run.txt');
  const sameCommand = `node -e "require('fs').writeFileSync('same-command.txt','executed')"`;
  const differentCommand = `node -e "require('fs').writeFileSync('different-command-must-not-run.txt','executed')"`;
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      res.end(tool('windows-session-first', 'Bash', { command: sameCommand }));
    } else if (requests.length === 2) {
      res.end(tool('windows-session-same', 'Bash', { command: sameCommand }));
    } else if (requests.length === 3) {
      res.end(tool('windows-session-different', 'Bash', { command: differentCommand }));
    } else {
      res.end(final('Exact session permission was preserved on Windows.'));
    }
  });
  let session;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    session = await startConpty({
      workspace, port: server.address().port,
      prompt: 'Run the same approved command twice, then try a different command.',
    });
    await waitUntil(() => normalizeTuiOutput(session.output).includes('Permission required'),
      10000, 'the initial Bash permission prompt', () => session.output);
    // Original Select navigation: defaultToNo focuses Deny. Move to Allow,
    // then the exact-command session option, and explicitly submit it.
    session.terminal.write('\x1b[B');
    await new Promise(resolve => setTimeout(resolve, 220));
    session.terminal.write('\x1b[B');
    await new Promise(resolve => setTimeout(resolve, 220));
    session.terminal.write('\r');
    await waitUntil(() => requests.length >= 3, 12000,
      'the third provider request after the identical command was auto-allowed',
      () => session.output);
    const beforeDifferentCommandPrompt = session.output.length;
    await waitUntil(
      () => session.output.length > beforeDifferentCommandPrompt &&
        normalizeTuiOutput(session.output).slice(-2500).includes('Permission required'),
      8000, 'the different command approval prompt', () => session.output,
    );
    assert.equal(requests.length, 3,
      'the exact session rule must not authorize a different Bash command');
    session.terminal.write('\r');
    await waitUntil(
      () => normalizeTuiOutput(session.output).includes('Exact session permission was preserved on Windows.') &&
        normalizeTuiOutput(session.output).includes('you>'),
      10000, 'the final response and resumed input prompt', () => session.output,
    );
    session.terminal.write('/exit\r');
    const exit = await waitForExit(session.exitPromise, 5000);
    assert.ok(exit, session.output);
    assert.equal(exit.exitCode, 0, session.output);
    assert.equal(await readFile(firstMarker, 'utf8'), 'executed');
    await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
    assert.equal(requests.length, 4);
    const first = requests[1].messages.at(-1).content[0];
    assert.equal(first.tool_use_id, 'windows-session-first');
    assert.equal(first.is_error, undefined, JSON.stringify(first));
    const same = requests[2].messages.at(-1).content[0];
    assert.equal(same.tool_use_id, 'windows-session-same');
    assert.equal(same.is_error, undefined, JSON.stringify(same));
    const different = requests[3].messages.at(-1).content[0];
    assert.equal(different.tool_use_id, 'windows-session-different');
    assert.equal(different.is_error, true, JSON.stringify(different));
    assert.doesNotMatch(session.output,
      /Could not start the original Ink TUI|falling back to the readline interface/);
  } finally {
    await disposeTerminal(session);
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});
