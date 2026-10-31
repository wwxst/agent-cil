import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeTuiOutput } from './tui-test-helpers.js';

// This test exercises the actual built-in Bash policy -> AgentLoop ->
// approvalHandler -> Ink PermissionPrompt path, not a standalone controller.
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

test('2.1.304 defaultToNo: Bash Select hides indexes and ignores numeric/Y shortcuts before Deny', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows uses native ConPTY coverage',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-default-to-no-'));
  const marker = join(workspace, 'must-not-run.txt');
  const command = 'node -e "require(\'fs\').writeFileSync(\'must-not-run.txt\',\'executed\')"';
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(calls.length === 1
      ? toolStream('default-to-no-bash', 'Bash', { command })
      : finishStream('Denied safely by defaultToNo.'));
  });
  let child;
  let watchdog;
  let digitTimer;
  let yTimer;
  let sentDigit = false;
  let sentY = false;
  let sentEnter = false;
  let permissionPromptSnapshot = '';
  let submittedExits = 0;
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
      '--model', 'default-to-no-approval-fixture', 'Please run the requested shell command.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'default-to-no-key', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);
      if (!sentDigit && visible.includes('Permission required')) {
        permissionPromptSnapshot = visible.slice(visible.indexOf('Permission required'));
        sentDigit = true;
        // 2.1.304 defaultToNo hides indexes and disables both ASCII and
        // full-width numeric selection; Y is not a Select option shortcut.
        child.stdin.write('２');
        digitTimer = setTimeout(() => {
          sentY = true;
          child.stdin.write('y');
          yTimer = setTimeout(() => {
            sentEnter = true;
            child.stdin.write('\r');
          }, 220);
        }, 220);
      }
      if (submittedExits === 0 &&
          visible.includes('Denied safely by defaultToNo.') &&
          visible.includes('you> ')) {
        submittedExits++;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 17000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(sentDigit, true, output);
    assert.equal(sentY, true, output);
    assert.equal(sentEnter, true, output);
    assert.equal(submittedExits, 1, output);
    assert.doesNotMatch(permissionPromptSnapshot, /\b[1-3]\.\s/,
      'defaultToNo must hide the option indexes');
    assert.doesNotMatch(output + stderr, /Could not start the original Ink TUI|falling back to the readline interface/);
    await assert.rejects(access(marker), { code: 'ENOENT' },
      'defaultToNo must ignore digit/Y shortcuts and keep Enter on the first Deny option');
    assert.equal(calls.length, 2, output);
    const blocks = calls[1].messages.at(-1).content;
    assert.equal(blocks[0].tool_use_id, 'default-to-no-bash');
    assert.equal(blocks[0].is_error, true, JSON.stringify(blocks));
  } finally {
    if (digitTimer) clearTimeout(digitTimer);
    if (yTimer) clearTimeout(yTimer);
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
