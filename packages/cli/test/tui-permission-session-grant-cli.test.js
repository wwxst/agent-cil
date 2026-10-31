import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeTuiOutput } from './tui-test-helpers.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const event = (type, payload = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n';
const toolStream = (id, name, input) => [
  event('message_start', { message: { usage: { input_tokens: 2 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
  event('content_block_stop', { index: 0 }),
  event('message_delta', { delta: { stop_reason: 'tool_use' } }),
  event('message_stop'),
].join('');
const finishStream = text => [
  event('message_start', { message: { usage: { input_tokens: 2 } } }),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  event('content_block_stop', { index: 0 }),
  event('message_delta', { delta: { stop_reason: 'end_turn' } }),
  event('message_stop'),
].join('');

function waitForCallCount(calls, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      if (calls.length >= count) {
        clearInterval(interval);
        clearTimeout(timeout);
        resolve();
      }
    }, 25);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('Timed out waiting for provider request ' + count + '; received ' + calls.length));
    }, timeoutMs);
  });
}

test('Bash session grant reuses the original PermissionUpdate contract and applies only to the exact command', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows uses native ConPTY coverage',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-session-grant-'));
  const firstMarker = join(workspace, 'same-command.txt');
  const secondMarker = join(workspace, 'different-command-must-not-run.txt');
  const sameCommand = 'node -e "require(\'fs\').writeFileSync(\'same-command.txt\',\'executed\')"';
  const differentCommand = 'node -e "require(\'fs\').writeFileSync(\'different-command-must-not-run.txt\',\'executed\')"';
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (calls.length === 1) {
      res.end(toolStream('session-grant-first', 'Bash', { command: sameCommand }));
    } else if (calls.length === 2) {
      // An exact session rule must authorize this identical command without
      // displaying another prompt.
      res.end(toolStream('session-grant-same', 'Bash', { command: sameCommand }));
    } else if (calls.length === 3) {
      // The session rule must not broaden to a different Bash command.
      res.end(toolStream('session-grant-different', 'Bash', { command: differentCommand }));
    } else {
      res.end(finishStream('Exact session permission was preserved.'));
    }
  });
  let child;
  let watchdog;
  let sentSessionGrant = false;
  let sentExit = false;
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
      '--model', 'permission-session-grant-fixture', 'Run the same approved command twice, then try a different command.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'session-grant-key', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);
      if (!sentSessionGrant && visible.includes('Permission required')) {
        sentSessionGrant = true;
        // Original CustomSelect supports immediate 1-based selection:
        // option 2 is the exact-command session grant.
        child.stdin.write('２');
      }
      if (!sentExit &&
          visible.includes('Exact session permission was preserved.') &&
          visible.includes('you> ')) {
        sentExit = true;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 19000);

    await waitForCallCount(calls, 2);
    // If the exact session update did not take effect, the identical command
    // would be waiting for another approval and this provider request 3 would
    // never arrive.
    await waitForCallCount(calls, 3);
    // The third command differs. It must be awaiting approval, not executing.
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(calls.length, 3, 'a session grant for one command must not allow a different Bash command');
    assert.match(normalizeTuiOutput(output).slice(-2500), /Permission required/);
    child.stdin.write('\r'); // defaultToNo Deny for the different command

    await waitForCallCount(calls, 4);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(sentSessionGrant, true, output);
    assert.equal(sentExit, true, output);
    assert.doesNotMatch(output + stderr, /Could not start the original Ink TUI|falling back to the readline interface/);
    assert.equal(await readFile(firstMarker, 'utf8'), 'executed');
    await assert.rejects(readFile(secondMarker), { code: 'ENOENT' });
    assert.equal(calls.length, 4);
    const firstResult = calls[1].messages.at(-1).content[0];
    assert.equal(firstResult.tool_use_id, 'session-grant-first');
    assert.equal(firstResult.is_error, undefined, JSON.stringify(firstResult));
    const sameResult = calls[2].messages.at(-1).content[0];
    assert.equal(sameResult.tool_use_id, 'session-grant-same');
    assert.equal(sameResult.is_error, undefined, JSON.stringify(sameResult));
    const differentResult = calls[3].messages.at(-1).content[0];
    assert.equal(differentResult.tool_use_id, 'session-grant-different');
    assert.equal(differentResult.is_error, true, JSON.stringify(differentResult));
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
