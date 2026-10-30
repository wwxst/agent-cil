import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('Windows ConPTY routes Ctrl+C through readline and preserves cancel/clear/double-press behavior', {
  timeout: 30000,
  skip: process.platform !== 'win32',
}, async () => {
  const { spawn: spawnPty } = await import('node-pty').then(module =>
    module.default ?? module,
  );
  assert.equal(typeof spawnPty, 'function', 'node-pty must be installed by the Windows CI job');

  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-conpty-ctrlc-'));
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
      // Keep the first SSE response open until the ConPTY Ctrl+C aborts it.
    } else {
      res.end(final('RESUMED'));
    }
  });

  let terminal, watchdog, idleClearTimer, idleExitTimer, didExit = false;
  let output = '';
  let sentBusyInterrupt = false;
  let sentClearInterrupt = false;
  let sentContinue = false;
  let sentIdleExitFirst = false;
  let sentIdleExitSecond = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    terminal = spawnPty(process.execPath, [
      cli, '--provider', 'deepseek', '--max-retries', '0',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
      'Start a long response; do not call tools.',
    ], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workspace,
      useConpty: true,
      env: { ...process.env, TERM: 'xterm-256color', DEEPSEEK_API_KEY: 'fixture-windows-conpty-key' },
    });

    terminal.onData(data => {
      output += data;
      if (!sentBusyInterrupt && output.includes('STREAMING')) {
        sentBusyInterrupt = true;
        // The second key arrives while the cancelled turn is still settling.
        // It must arm, not complete, the idle double-press exit.
        terminal.write('\x03\x03');
      }

      if (sentBusyInterrupt && !sentClearInterrupt &&
        output.includes('Interrupted.') && output.includes('you>')) {
        sentClearInterrupt = true;
        // Let the first-press window armed during cancellation expire; this
        // fresh idle press must clear the pending input instead of submitting it.
        idleClearTimer = setTimeout(() => terminal.write('discard-this\x03'), 850);
      }

      const exitHintCount = (output.match(/Press Ctrl\+C again to exit\./g) || []).length;
      if (sentClearInterrupt && !sentContinue && exitHintCount >= 2) {
        sentContinue = true;
        terminal.write('continue\r');
      }

      const promptCount = (output.match(/you>/g) || []).length;
      if (sentContinue && !sentIdleExitFirst &&
        promptCount >= 2 && output.includes('RESUMED')) {
        sentIdleExitFirst = true;
        // The previous idle clear armed the legacy timer. Wait for it to
        // expire before starting a separate empty-prompt double-press exit.
        idleExitTimer = setTimeout(() => terminal.write('\x03'), 850);
      }

      if (sentIdleExitFirst && !sentIdleExitSecond && exitHintCount >= 3) {
        sentIdleExitSecond = true;
        terminal.write('\x03');
      }
    });

    const forceKill = () => {
      try {
        execFileSync('taskkill', ['/PID', String(terminal.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      } catch {}
    };
    const exitPromise = new Promise(resolve => {
      terminal.onExit(info => {
        didExit = true;
        resolve(info);
      });
    });
    const result = await Promise.race([
      exitPromise,
      new Promise(resolve => { watchdog = setTimeout(() => resolve(null), 7000); }),
    ]);
    if (!result) {
      forceKill();
      throw new Error('ConPTY CLI did not exit after the expected Ctrl+C sequence:\n' + output);
    }

    assert.equal(result.exitCode, 130, output);
    assert.equal(sentBusyInterrupt, true, output);
    assert.equal(sentClearInterrupt, true, output);
    assert.equal(sentContinue, true, output);
    assert.equal(sentIdleExitFirst, true, output);
    assert.equal(sentIdleExitSecond, true, output);
    assert.ok((output.match(/Press Ctrl\+C again to exit\./g) || []).length >= 3, output);
    assert.match(output, /Interrupted by user/);
    assert.match(output, /RESUMED/);
    assert.equal(requests.length, 2, 'cancelled SSE must not replay and cleared input must not submit');
    assert.equal(JSON.stringify(requests[1]).includes('discard-this'), false,
      'ConPTY first idle Ctrl+C must clear the readline buffer');
    assert.equal(output.includes('fixture-windows-conpty-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (idleClearTimer) clearTimeout(idleClearTimer);
    if (idleExitTimer) clearTimeout(idleExitTimer);
    if (terminal && !didExit) {
      try {
        execFileSync('taskkill', ['/PID', String(terminal.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
    }
    if (openStream && !openStream.destroyed) openStream.destroy();
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});
