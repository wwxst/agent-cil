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

test('installed original PermissionPrompt Tab feedback is retained after a real Bash tool_result', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows runs the native ConPTY harness',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-feedback-approval-'));
  const marker = join(workspace, 'feedback-approved-run.txt');
  const command = 'node -e "require(\'fs\').writeFileSync(\'feedback-approved-run.txt\',\'executed\')"';
  const feedback = 'Only run the exact reviewed command.';
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(calls.length === 1
      ? toolStream('feedback-tool-use', 'Bash', { command })
      : finishStream('Approval feedback was retained.'));
  });
  let child;
  let watchdog;
  const timers = [];
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
      '--model', 'approval-feedback-tty-fixture', 'Please run the requested shell command.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'approval-feedback-tty-key', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let approvalPrompts = 0;
    let feedbackPrompts = 0;
    let feedbackSubmitted = 0;
    let submittedExits = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);
      // Permission keys are scheduled after the local SSE response below.

      if (submittedExits === 0 &&
          visible.includes('Approval feedback was retained.') &&
          visible.includes('you> ')) {
        submittedExits++;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timers.push(setTimeout(() => { approvalPrompts++; child.stdin.write('\x1b[B'); }, 2000));
    timers.push(setTimeout(() => child.stdin.write('\t'), 2240));
    timers.push(setTimeout(() => { feedbackPrompts++; child.stdin.write(feedback); }, 2480));
    // The original 2.1.88 selector retains non-empty feedback when focus
    // leaves its option; move to Deny, return to Allow, then submit it.
    timers.push(setTimeout(() => child.stdin.write('\x1b[A'), 2760));
    timers.push(setTimeout(() => child.stdin.write('\x1b[B'), 3000));
    timers.push(setTimeout(() => { feedbackSubmitted++; child.stdin.write('\r'); }, 3240));
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
    assert.equal(feedbackPrompts, 1, output);
    assert.equal(feedbackSubmitted, 1, output);
    assert.equal(submittedExits, 1, output);
    assert.equal(await readFile(marker, 'utf8'), 'executed');
    assert.equal(calls.length, 2, output);
    const blocks = calls[1].messages.at(-1).content;
    assert.equal(blocks[0].type, 'tool_result', JSON.stringify(blocks));
    assert.equal(blocks[0].tool_use_id, 'feedback-tool-use');
    assert.equal(blocks[0].is_error, undefined, JSON.stringify(blocks));
    assert.ok(blocks.some(block => block.type === 'text' && block.text === feedback),
      'original acceptFeedback must be appended after the authenticated tool_result');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('installed original PermissionPrompt reject feedback remains the denial reason', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows runs the native ConPTY harness',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-reject-feedback-'));
  const marker = join(workspace, 'must-not-run-after-reject-feedback.txt');
  const command = 'node -e "require(\'fs\').writeFileSync(\'must-not-run-after-reject-feedback.txt\',\'executed\')"';
  const feedback = 'I did not ask to run this command.';
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(calls.length === 1
      ? toolStream('rejected-feedback-tool-use', 'Bash', { command })
      : finishStream('The denial feedback was retained.'));
  });
  let child;
  let watchdog;
  const timers = [];
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
      '--model', 'approval-reject-feedback-tty-fixture', 'Please run the requested shell command.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'approval-reject-feedback-tty-key', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let approvalPrompts = 0;
    let feedbackPrompts = 0;
    let feedbackSubmitted = 0;
    let submittedExits = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output);
      // Permission keys are scheduled after the local SSE response below.

      if (submittedExits === 0 &&
          visible.includes('The denial feedback was retained.') &&
          visible.includes('you> ')) {
        submittedExits++;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timers.push(setTimeout(() => { approvalPrompts++; child.stdin.write('\t'); }, 2000));
    timers.push(setTimeout(() => { feedbackPrompts++; child.stdin.write(feedback); }, 2240));
    timers.push(setTimeout(() => { feedbackSubmitted++; child.stdin.write('\r'); }, 2480));
    watchdog = setTimeout(() => child.kill('SIGKILL'), 17000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.doesNotMatch(output + stderr, /Could not start the original Ink TUI|falling back to the readline interface/);
    assert.equal(approvalPrompts, 1, output);
    assert.equal(feedbackPrompts, 1, output);
    assert.equal(feedbackSubmitted, 1, output);
    assert.equal(submittedExits, 1, output);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(calls.length, 2, output);
    const blocks = calls[1].messages.at(-1).content;
    assert.equal(blocks[0].type, 'tool_result', JSON.stringify(blocks));
    assert.equal(blocks[0].tool_use_id, 'rejected-feedback-tool-use');
    assert.equal(blocks[0].is_error, true, JSON.stringify(blocks));
    assert.match(blocks[0].content, /I did not ask to run this command\./);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});


test('Ctrl-D in an empty original permission feedback editor cancels the request, not the CLI session', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows runs the native ConPTY harness',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-feedback-ctrld-'));
  const marker = join(workspace, 'must-not-run-after-ctrl-d-cancel.txt');
  const command = 'node -e "require(\'fs\').writeFileSync(\'must-not-run-after-ctrl-d-cancel.txt\',\'executed\')"';
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(calls.length === 1
      ? toolStream('ctrl-d-feedback-tool-use', 'Bash', { command })
      : finishStream('The permission request was cancelled.'));
  });
  let child;
  let watchdog;
  const timers = [];
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
      '--model', 'approval-feedback-ctrl-d-fixture', 'Please run the requested shell command.',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'approval-feedback-ctrl-d-key', LANG: 'en_US.UTF-8' },
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
      if (submittedExits === 0 &&
          visible.includes('The permission request was cancelled.') &&
          visible.includes('you> ')) {
        submittedExits++;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timers.push(setTimeout(() => { approvalPrompts++; child.stdin.write('\x1b[B'); }, 2000));
    timers.push(setTimeout(() => child.stdin.write('\t'), 2240));
    timers.push(setTimeout(() => child.stdin.write('\x04'), 2480));
    timers.push(setTimeout(() => child.stdin.write('\x04'), 2760));
    watchdog = setTimeout(() => child.kill('SIGKILL'), 17000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(approvalPrompts, 1, output);
    assert.equal(submittedExits, 1, output);
    assert.doesNotMatch(output + stderr, /Could not start the original Ink TUI|falling back to the readline interface/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(calls.length, 2, output);
    const blocks = calls[1].messages.at(-1).content;
    assert.equal(blocks[0].tool_use_id, 'ctrl-d-feedback-tool-use');
    assert.equal(blocks[0].is_error, true, JSON.stringify(blocks));
    assert.match(blocks[0].content, /User denied the tool call/);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
