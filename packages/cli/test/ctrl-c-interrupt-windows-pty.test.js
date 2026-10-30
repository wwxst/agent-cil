import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
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

test('Windows ConPTY delivers Ctrl+C to active cancellation and idle input clearing', {
  timeout: 30000,
  skip: process.platform !== 'win32',
}, async () => {
  const { spawn: spawnPty } = await import('node-pty').then(module =>
    module.default ?? module,
  );
  assert.equal(typeof spawnPty, 'function', 'node-pty must be installed by the Windows CI job');

  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-conpty-ctrlc-'));
  const requests = [];
  let firstResponseAborted = false;
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      res.on('close', () => {
        firstResponseAborted = !res.writableEnded;
      });
      res.write(sse('message_start', { message: { usage: { input_tokens: 3 } } }) +
        sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'STREAMING' } }));
      // Keep the response open until the real ConPTY Ctrl+C aborts the request.
    } else {
      res.end(final('UNEXPECTED-SECOND-REQUEST'));
    }
  });

  const terminals = [];
  const startTerminal = args => {
    const terminal = spawnPty(process.execPath, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workspace,
      useConpty: true,
      useConptyDll: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        DEEPSEEK_API_KEY: 'fixture-windows-conpty-key',
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
    const session = {
      terminal,
      exitPromise,
      get output() { return output; },
      get didExit() { return didExit; },
    };
    terminals.push(session);
    return session;
  };

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    // First prove that Ctrl+C sent through ConPTY aborts a real in-flight
    // streaming request and returns the interactive CLI to its prompt.
    const active = startTerminal([
      cli, '--provider', 'deepseek', '--max-retries', '0',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
      'Start a long response; do not call tools.',
    ]);
    await waitUntil(() => active.output.includes('STREAMING'), 10000,
      'the active streaming response', () => active.output);
    active.terminal.write('\x03');
    await waitUntil(
      () => active.output.includes('Interrupted.') && active.output.includes('you>'),
      10000,
      'the prompt after Ctrl+C cancellation',
      () => active.output,
    );
    active.terminal.write('/exit\r');
    const activeExit = await waitForExit(active.exitPromise, 5000);
    assert.ok(activeExit, 'active-turn CLI did not exit after /exit: ' + active.output);
    assert.equal(activeExit.exitCode, 0, active.output);
    assert.equal(requests.length, 1, 'the cancelled turn must not be replayed');
    assert.equal(firstResponseAborted, true, 'Ctrl+C must abort the open SSE response');

    // Then prove that idle Ctrl+C clears a typed but unsubmitted line. If the
    // line survives, appending /exit submits it as a model prompt instead.
    const idle = startTerminal([
      cli, '--provider', 'deepseek', '--max-retries', '0',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
    ]);
    await waitUntil(() => idle.output.includes('you>'), 10000,
      'the initial idle prompt', () => idle.output);
    idle.terminal.write('discard-this');
    await waitUntil(() => idle.output.includes('discard-this'), 5000,
      'the typed idle input', () => idle.output);
    idle.terminal.write('\x03');
    await waitUntil(() => idle.output.includes('Press Ctrl+C again to exit.'), 5000,
      'the first-press clear hint', () => idle.output);
    idle.terminal.write('/exit\r');
    const idleExit = await waitForExit(idle.exitPromise, 5000);
    assert.ok(idleExit, 'idle CLI did not exit after cleared input and /exit: ' + idle.output);
    assert.equal(idleExit.exitCode, 0, idle.output);
    assert.equal(requests.length, 1,
      'the cleared idle input must not become a second model request');
    assert.equal(JSON.stringify(requests).includes('discard-this'), false);
    assert.equal(active.output.includes('fixture-windows-conpty-key'), false);
    assert.equal(idle.output.includes('fixture-windows-conpty-key'), false);
  } finally {
    for (const session of terminals) {
      if (!session.didExit) {
        // This test owns only a single CLI child (no tool subprocesses). Kill
        // that process directly first so a stuck ConPTY transport cannot keep
        // the test runner alive; then close node-pty's native handles.
        try { process.kill(session.terminal.pid); } catch {}
        try { session.terminal.kill(); } catch {}
        await waitForExit(session.exitPromise, 2000);
      }
    }
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});
