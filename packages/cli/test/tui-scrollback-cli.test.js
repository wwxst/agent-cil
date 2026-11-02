import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTerminalScreen, normalizeTuiText } from './tui-test-helpers.js';

// This test also runs against the npm-pack-installed CLI executable.
const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const event = (type, payload = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n';
const finishStream = text => [
  event('message_start', { message: { usage: { input_tokens: 2 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  event('content_block_stop', { index: 0 }),
  event('message_delta', { delta: { stop_reason: 'end_turn' } }),
  event('message_stop'),
].join('');
const pad = value => String(value).padStart(2, '0');

async function spawnWindowsConpty(cliPath, args, { cwd, env, cols, rows }) {
  const { spawn: spawnPty } = await import('node-pty').then(module =>
    module.default ?? module,
  );
  assert.equal(typeof spawnPty, 'function',
    'node-pty must be installed by the Windows ConPTY CI job');
  const terminal = spawnPty(process.execPath, [cliPath, ...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    useConpty: true,
    env,
  });
  const child = new EventEmitter();
  const stream = () => {
    const value = new EventEmitter();
    value.setEncoding = () => value;
    return value;
  };
  child.stdout = stream();
  child.stderr = stream();
  child.stdin = { write: value => terminal.write(value) };
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    try { terminal.kill(); } catch {}
  };
  terminal.onData(data => child.stdout.emit('data', data));
  terminal.onExit(({ exitCode, signal }) => {
    child.exitCode = exitCode;
    child.emit('close', exitCode, signal ?? null);
  });
  return child;
}

test('original 2.1.88 ScrollBox supports PageUp/PageDown and the 2.1.304 Home/End pager keys', {
  timeout: 45000,
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
  let output = '';
  let stderr = '';
  const terminalScreen = createTerminalScreen(100, 24);
  let sentPrompts = 0;
  let pageUpStarted = false;
  let pageUpCount = 0;
  let pageDownStarted = false;
  let pageDownCount = 0;
  let endSent = false;
  let homeSent = false;
  let exitSent = false;
  let outputAtPageUp = 0;
  let outputAtEnd = 0;
  let outputAtHome = 0;
  let outputAtPageDown = 0;
  const totalTurns = 12;
  const timers = new Set();
  const later = (callback, delay) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  };
  const sendPrompt = number => {
    child.stdin.write('prompt-' + pad(number));
    const submitWhenReady = () => {
      if (calls.length >= number || exitSent || child.exitCode !== null || child.killed) return;
      child.stdin.write('\r');
      later(submitWhenReady, 250);
    };
    // The prompt can be painted before the TUI has re-enabled submission.
    // Retry Enter until the fixture server observes this exact turn.
    later(submitWhenReady, 300);
  };
  let endWaitTicks = 0;
  const maybeSendEnd = () => {
    if (endSent || !pageUpStarted || pageUpCount < 16 || exitSent) return;
    if (normalizeTuiText(output.slice(outputAtPageUp)).includes('End to jump to latest')) {
      endSent = true;
      outputAtEnd = output.length;
      child.stdin.write('\x1b[4~');
      return;
    }
    // Reaching the scroll boundary can produce no further terminal output.
    // Do not make the final PageUp keypress depend on another stdout event:
    // observe the already-emitted frame after the key has had time to drain.
    if (endWaitTicks++ < 20) later(maybeSendEnd, 50);
  };
  const sendPageUp = () => {
    if (pageUpCount >= 16 || exitSent) return;
    child.stdin.write('\x1b[5~');
    pageUpCount += 1;
    if (pageUpCount >= 16) {
      later(maybeSendEnd, 120);
      return;
    }
    later(sendPageUp, 90);
  };
  let pageDownWaitTicks = 0;
  const maybeSendExit = () => {
    if (!pageDownStarted || pageDownCount < 16 || exitSent) return;
    const screenText = terminalScreen.toString();
    if (screenText.includes('reply-' + pad(totalTurns)) &&
        !screenText.includes('reply-01') &&
        !screenText.includes('End to jump to latest') &&
        screenText.includes('Describe a task')) {
      exitSent = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      child.stdin.write('/exit\r');
      return;
    }
    // As with PageUp at the top boundary, the final PageDown may not produce
    // another terminal frame once sticky follow has been restored.
    if (pageDownWaitTicks++ < 20) later(maybeSendExit, 50);
  };
  const sendPageDown = () => {
    if (pageDownCount >= 16 || exitSent) return;
    child.stdin.write('\x1b[6~');
    pageDownCount += 1;
    if (pageDownCount >= 16) {
      later(maybeSendExit, 120);
      return;
    }
    later(sendPageDown, 90);
  };

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint === 'object');

    const cliArgs = [
      '--language', 'en',
      '--max-retries', '0',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + endpoint.port,
      '--model', 'scrollback-tty-fixture',
    ];
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: 'scrollback-tty-key',
      AGENT_CIL_CONFIG_DIR: join(workspace, '.agent-cil-test-config'),
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLUMNS: '100',
      LINES: '24',
    };
    if (process.platform === 'win32') {
      // Exercise the exact same pager state machine on native ConPTY. The
      // terminal dimensions are set by ConPTY itself; no POSIX shell shim
      // is involved.
      child = await spawnWindowsConpty(cli, cliArgs, {
        cwd: workspace, env, cols: 100, rows: 24,
      });
    } else {
      const args = [process.execPath, cli, ...cliArgs];
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const command = 'stty rows 24 cols 100; ' + args.map(quote).join(' ');
      child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
        cwd: workspace,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      terminalScreen.write(chunk);
      const screenText = terminalScreen.toString();
      // The transcript itself contains historical "you> " labels. Never use
      // the cumulative PTY byte stream as a readiness signal: after turn one
      // it would remain true forever and race subsequent prompts into the
      // previous frame. The unique empty-input placeholder is only present
      // when the current input is mounted and ready for another turn.
      const inputReady = screenText.includes('Describe a task');

      if (sentPrompts === 0 && inputReady) {
        sentPrompts = 1;
        sendPrompt(1);
        return;
      }

      if (sentPrompts > 0 && sentPrompts < totalTurns &&
          screenText.includes('reply-' + pad(sentPrompts)) && inputReady) {
        sentPrompts += 1;
        sendPrompt(sentPrompts);
        return;
      }

      if (sentPrompts === totalTurns && !pageUpStarted &&
          screenText.includes('reply-' + pad(totalTurns)) && inputReady) {
        pageUpStarted = true;
        assert.ok(screenText.includes('reply-' + pad(totalTurns)),
          'the newest turn must be visible before scrolling: ' + screenText);
        assert.ok(!screenText.includes('reply-01'),
          'the oldest turn must be outside the bottom viewport before PageUp: ' + screenText);
        outputAtPageUp = output.length;
        sendPageUp();
        return;
      }

      // The minimal VT grid cannot faithfully model the original renderer's
      // scroll-region redraws. maybeSendEnd observes the emitted PTY frame and
      // also runs after the final PageUp, because the top boundary may not
      // produce another stdout event.
      maybeSendEnd();

      if (endSent && !homeSent &&
          screenText.includes('reply-' + pad(totalTurns)) &&
          !screenText.includes('reply-01') && inputReady &&
          !screenText.includes('End to jump to latest')) {
        homeSent = true;
        outputAtHome = output.length;
        child.stdin.write('\x1b[1~');
        return;
      }

      const homeOutput = normalizeTuiText(output.slice(outputAtHome));
      if (homeSent && !pageDownStarted &&
          homeOutput.includes('reply-01') &&
          homeOutput.includes('End to jump to latest')) {
        pageDownStarted = true;
        outputAtPageDown = output.length;
        sendPageDown();
        return;
      }
      maybeSendExit();
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => {
      const normalizedAfterPageUp = normalizeTuiText(output.slice(outputAtPageUp));
      process.stderr.write('[tui-scrollback-debug] ' + JSON.stringify({
        sentPrompts,
        pageUpStarted,
        pageUpCount,
        endSent,
        homeSent,
        pageDownStarted,
        pageDownCount,
        exitSent,
        afterPageUpHasOldest: normalizedAfterPageUp.includes('reply-01'),
        afterPageUpHasHint: normalizedAfterPageUp.includes('End to jump to latest'),
        afterEndHasLatest: normalizeTuiText(output.slice(outputAtEnd)).includes('reply-' + pad(totalTurns)),
        afterPageDownHasLatest: normalizeTuiText(output.slice(outputAtPageDown)).includes('reply-' + pad(totalTurns)),
        screen: terminalScreen.toString(),
      }) + '\\n');
      child.kill('SIGKILL');
    }, 10000);

    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });

    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(sentPrompts, totalTurns, stderr + output);
    assert.ok(pageUpStarted, 'PageUp sequence was not sent: ' + stderr + output);
    assert.ok(pageUpCount > 0, 'no PageUp keypresses were sent');
    assert.ok(endSent, 'End did not restore the latest turn: ' + stderr + output);
    assert.ok(homeSent, 'Home did not return to the first turn: ' + stderr + output);
    assert.ok(pageDownStarted, 'PageDown sequence was not sent: ' + stderr + output);
    assert.ok(pageDownCount > 0, 'no PageDown keypresses were sent');
    assert.ok(exitSent, 'PageDown did not restore the latest turn and clear the jump hint: ' + stderr + output);
    assert.equal(calls.length, totalTurns, stderr + output);
    assert.ok(
      calls.every((call, index) =>
        JSON.stringify(call).includes('prompt-' + pad(index + 1)),
      ),
      'every interactive prompt must reach the model in order',
    );
    assert.doesNotMatch(output + stderr,
      /Could not start the original Ink TUI|falling back to the readline interface/);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
