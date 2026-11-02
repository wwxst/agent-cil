import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTerminalScreen, normalizeTuiOutput } from './tui-test-helpers.js';

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
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { write: value => terminal.write(value) };
  child.exitCode = null;
  child.killed = false;
  child.cleanup = () => {
    try { terminal.kill(); } catch {}
  };
  child.kill = () => {
    child.killed = true;
    child.cleanup();
  };
  terminal.onData(data => child.stdout.write(data));
  terminal.onExit(({ exitCode, signal }) => {
    child.exitCode = exitCode;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode, signal ?? null);
  });
  return child;
}

test('Ink TUI switches live between Simplified Chinese and English and persists the preference', {
  timeout: 40000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-language-'));
  const configDirectory = join(workspace, '.agent-cil-test-config');
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(finishStream('TUI_LANGUAGE_TURN_' + requests.length));
  });

  let child;
  let watchdog;
  let output = '';
  let stderr = '';
  let stage = 0;
  let outputMark = 0;
  let sentExit = false;
  let promptRetryTimer;
  let escapeTimer;
  const terminalScreen = createTerminalScreen(110, 32);

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint === 'object');
    const args = [
      '--language', 'en',
      '--max-retries', '0',
      '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + endpoint.port,
      '--model', 'tui-language-tty-fixture',
      'First prompt for the live TUI language test',
    ];
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: 'tui-language-tty-key',
      AGENT_CIL_CONFIG_DIR: configDirectory,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      COLUMNS: '110',
      LINES: '32',
    };
    if (process.platform === 'win32') {
      child = await spawnWindowsConpty(cli, args, {
        cwd: workspace, env, cols: 110, rows: 32,
      });
    } else {
      const commandArgs = [process.execPath, cli, ...args];
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const command = 'stty rows 32 cols 110; ' + commandArgs.map(quote).join(' ');
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
      const visible = terminalScreen.toString();
      const normalized = normalizeTuiOutput(output);

      if (stage === 0 &&
          visible.includes('TUI_LANGUAGE_TURN_1') &&
          visible.includes('Describe a task')) {
        stage = 1;
        outputMark = output.length;
        child.stdin.write('/language zh-CN\r');
        return;
      }

      if (stage === 1 &&
          normalizeTuiOutput(output.slice(outputMark)).includes('界面语言已切换为 简体中文。') &&
          normalizeTuiOutput(output.slice(outputMark)).includes('输入任务')) {
        // The original 2.1.88 useTextInput hook emits an English internal
        // notification. The live TUI must translate it using the current
        // language, not the language captured when Ink first mounted.
        stage = 1.5;
        outputMark = output.length;
        child.stdin.write('draft for Escape translation');
        escapeTimer = setTimeout(() => child.stdin.write('\x1b'), 250);
        return;
      }

      if (stage === 1.5 &&
          normalizeTuiOutput(output.slice(outputMark)).includes('再次按 Esc 清空输入内容。')) {
        stage = 2;
        outputMark = output.length;
        child.stdin.write('\x1b'); // Complete original double-Escape clear.
        escapeTimer = setTimeout(() => child.stdin.write('/language\r'), 150);
        return;
      }

      if (stage === 2 &&
          normalizeTuiOutput(output.slice(outputMark)).includes('当前界面语言：简体中文')) {
        stage = 3;
        outputMark = output.length;
        child.stdin.write('/language en\r');
        return;
      }

      if (stage === 3 &&
          normalizeTuiOutput(output.slice(outputMark)).includes('Interface language set to English.')) {
        stage = 4;
        outputMark = output.length;
        // The command's localized status is emitted after setLocale. Wait for
        // the next React commit, then retry Enter until the provider observes
        // this exact second prompt. Incremental Ink output need not repaint an
        // unchanged English placeholder when switching back from Chinese.
        promptRetryTimer = setTimeout(() => {
          child.stdin.write('Second prompt after language switch');
          const submitWhenReady = () => {
            if (requests.length >= 2 || child.exitCode !== null || child.killed) return;
            child.stdin.write('\r');
            promptRetryTimer = setTimeout(submitWhenReady, 250);
          };
          promptRetryTimer = setTimeout(submitWhenReady, 300);
        }, 200);
        return;
      }

      if (stage === 4) {
        const secondTurnOutput = normalizeTuiOutput(output.slice(outputMark));
        if (secondTurnOutput.includes('TUI_LANGUAGE_TURN_2') &&
            secondTurnOutput.includes('Ready')) {
          stage = 5;
          sentExit = true;
          child.stdin.write('/exit\r');
          return;
        }
      }

      // Keep the cumulative normalized output observed for diagnostic errors.
      void normalized;
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 25000);

    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });

    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(stage, 5, 'not all live Ink language transitions completed: ' + terminalScreen.toString() + '\n' + stderr);
    assert.equal(sentExit, true);
    assert.equal(requests.length, 2, 'both real interactive prompts must reach the model');
    assert.match(JSON.stringify(requests[1].messages), /Second prompt after language switch/);
    assert.doesNotMatch(JSON.stringify(requests[1].messages), /\/language/);
    assert.match(normalizeTuiOutput(output), /界面语言已切换为 简体中文。/);
    assert.match(normalizeTuiOutput(output), /当前界面语言：简体中文/);
    assert.match(normalizeTuiOutput(output), /再次按 Esc 清空输入内容。/);
    assert.match(normalizeTuiOutput(output), /Interface language set to English\./);
    assert.doesNotMatch(output + stderr,
      /Could not start the original Ink TUI|falling back to the readline interface/);
    const config = JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8'));
    assert.equal(config.language, 'en');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (promptRetryTimer) clearTimeout(promptRetryTimer);
    if (escapeTimer) clearTimeout(escapeTimer);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    else child?.cleanup?.();
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
