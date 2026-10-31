import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeTuiOutput } from './tui-test-helpers.js';

// This test also runs through the CI npm-pack-installed CLI executable.
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

test('installed original 2.1.88 Select: Enter on its first Allow option approves a normal Write ask', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows runs the native approval-key tests',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-enter-approval-'));
  const marker = join(workspace, 'enter-approved-run.txt');
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(calls.length === 1
      ? toolStream('write-enter-default-allow', 'Write', { file_path: 'enter-approved-run.txt', content: 'executed' })
      : finishStream('Approved by the original first-option focus.'));
  });
  let child;
  let watchdog;
  let confirmTimer;
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
      '--model', 'approval-tty-fixture', 'Please run the requested shell command.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'approval-tty-key', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let approvalPrompts = 0;
    let submittedExits = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);
      // Key sequence is scheduled below, after the local fixture has responded.

      if (submittedExits === 0 &&
          visible.includes('Approved by the original first-option focus.') &&
          visible.includes('you> ')) {
        submittedExits++;
        child.stdin.write('/exit\r');
      }
    });
    confirmTimer = setTimeout(() => {
      approvalPrompts++;
      child.stdin.write('\r');
    }, 2000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 17000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.doesNotMatch(output + stderr, /Could not start the original Ink TUI|falling back to the readline interface/);
    assert.ok(normalizeTuiOutput(output).includes('Permission required'), output);
    assert.equal(approvalPrompts, 1, output);
    assert.equal(submittedExits, 1, output);
    await access(marker);
    assert.equal(calls.length, 2, output);
    const blocks = calls[1].messages.at(-1).content;
    assert.equal(blocks[0].tool_use_id, 'write-enter-default-allow');
    assert.equal(blocks[0].is_error, undefined, JSON.stringify(blocks));
  } finally {
    if (confirmTimer) clearTimeout(confirmTimer);
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('original CustomSelect: full-width numeric 1 selects Allow when defaultToNo is false', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows has native ConPTY coverage',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-numeric-approval-'));
  const marker = join(workspace, 'numeric-approved-run.txt');
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(calls.length === 1
      ? toolStream('write-numeric-default-allow', 'Write', {
          file_path: 'numeric-approved-run.txt',
          content: 'executed',
        })
      : finishStream('Approved by the original full-width numeric selector.'));
  });
  let child;
  let watchdog;
  let sentSelection = false;
  let submittedExit = false;
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
      '--model', 'approval-numeric-tty-fixture', 'Please write the requested file.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'approval-numeric-tty-key', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);
      if (!sentSelection && visible.includes('Permission required')) {
        sentSelection = true;
        child.stdin.write('１');
      }
      if (!submittedExit &&
          visible.includes('Approved by the original full-width numeric selector.') &&
          visible.includes('you> ')) {
        submittedExit = true;
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
    const visible = normalizeTuiOutput(output);
    assert.equal(sentSelection, true, output);
    assert.equal(submittedExit, true, output);
    assert.match(visible, /1\.\s*Allow/);
    assert.match(visible, /2\.\s*Deny/);
    assert.doesNotMatch(output + stderr, /Could not start the original Ink TUI|falling back to the readline interface/);
    assert.equal(await readFile(marker, 'utf8'), 'executed');
    assert.equal(calls.length, 2, output);
    const blocks = calls[1].messages.at(-1).content;
    assert.equal(blocks[0].tool_use_id, 'write-numeric-default-allow');
    assert.equal(blocks[0].is_error, undefined, JSON.stringify(blocks));
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
