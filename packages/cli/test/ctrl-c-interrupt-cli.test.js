import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
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
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

test('TTY Ctrl+C aborts in-flight DeepSeek SSE, does not exit, and idle Ctrl+C needs two presses', {
  timeout: 26000,
  skip: process.platform === 'win32', // Uses POSIX script(1); Windows ConPTY key injection is not covered here.
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-ctrlc-'));
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
      // Keep the SSE socket open until the CLI's AbortController cancels it.
    } else res.end(final('RESUMED'));
  });
  let child, watchdog, idleClearTimer;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    child = spawn('script', ['-q', '-e', '-c', [
      process.execPath, cli, '--provider', 'deepseek', '--max-retries', '0',
      '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + port + '/anthropic',
      'Start a long response; do not call tools.',
    ].map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-ctrlc-test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', err = '';
    let sentBusyInterrupt = false, sentIdleInterrupt = false;
    let sentContinue = false, sentExit = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!sentBusyInterrupt && output.includes('STREAMING')) {
        sentBusyInterrupt = true;
        // The second Ctrl+C may arrive while cancellation is still settling.
        // It must arm the idle first-press hint, never close readline early.
        child.stdin.write('\x03\x03');
      }
      if (sentBusyInterrupt && !sentIdleInterrupt &&
        output.includes('Interrupted.') && output.includes('you> ')) {
        sentIdleInterrupt = true;
        // Wait out the first-press window armed by the second Ctrl+C during
        // cancellation. This next press must start a fresh idle double-press.
        idleClearTimer = setTimeout(() => child.stdin.write('discard-this\x03'), 850);
      }
      const exitHintCount = (output.match(/Press Ctrl\+C again to exit\./g) || []).length;
      if (sentIdleInterrupt && !sentContinue && exitHintCount >= 2) {
        sentContinue = true;
        child.stdin.write('continue\n');
      }
      // Do not type the next command while the previous model turn is
      // still streaming. The old check fired on the first "RESUMED" delta,
      // before runPrompt wrote its newline and before readline asked again;
      // that input was consumed/lost while no question was active.
      const promptCount = (output.match(/you> /g) || []).length;
      if (sentContinue && !sentExit && promptCount >= 2 &&
        /assistant> RESUMED\r?\n/.test(output)) {
        sentExit = true;
        child.stdin.write('/exit\n');
      }
    });
    child.stderr.on('data', x => { err += x; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, output + err);
    assert.equal(status, 0, output + err);
    assert.equal(sentBusyInterrupt, true, output + err);
    assert.equal(sentIdleInterrupt, true, output + err);
    assert.equal(sentContinue, true, output + err);
    assert.equal(sentExit, true, output + err);
    assert.match(output, /Interrupted by user/);
    assert.match(output, /Press Ctrl\+C again to exit/);
    assert.match(output, /RESUMED/);
    assert.equal(requests.length, 2, 'cancelled partial SSE must not be replayed');
    assert.equal(JSON.stringify(requests[1]).includes('discard-this'), false,
      'first idle Ctrl+C must clear the current input instead of submitting it');
    assert.equal(output.includes('fixture-ctrlc-test-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (idleClearTimer) clearTimeout(idleClearTimer);
    if (openStream && !openStream.destroyed) openStream.destroy();
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});


test('TTY idle double Ctrl+C within legacy 800ms window exits without a model request', {
  timeout: 14000,
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-idle-ctrlc-'));
  let child, watchdog;
  try {
    child = spawn('script', ['-q', '-e', '-c',
      [process.execPath, cli, '--provider', 'deepseek', '--cwd', workspace]
        .map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'fake-idle-ctrlc-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', stderr = '', first = false, second = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!first && output.includes('you> ')) {
        first = true;
        child.stdin.write('\x03');
      }
      if (first && !second && output.includes('Press Ctrl+C again to exit.')) {
        second = true;
        child.stdin.write('\x03');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 9000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, output + stderr);
    assert.equal(status, 130, output + stderr);
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(output.includes('fake-idle-ctrlc-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    await rm(workspace, { recursive: true, force: true });
  }
});


test('first idle Ctrl+C resets readline history navigation to the newest entry', {
  timeout: 16000,
  skip: process.platform === 'win32', // Uses POSIX script(1); Windows ConPTY key injection is not covered here.
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-ctrlc-history-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(final('ANSWER-' + requests.length));
  });
  let child, watchdog;
  let output = '', stderr = '';
  let sentFirst = false, sentSecond = false;
  let sentHistoryUp = false, sentInterrupt = false;
  let sentHistoryUpAgain = false, sentExit = false;
  let historyResetVerified = false;
  let firstHistoryUpOffset = 0, secondHistoryUpOffset = 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    child = spawn('script', ['-q', '-e', '-c', [
      process.execPath, cli, '--provider', 'deepseek', '--max-retries', '0',
      '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
    ].map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-ctrlc-history-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const promptCount = (output.match(/you> /g) || []).length;
      if (!sentFirst && promptCount >= 1) {
        sentFirst = true;
        child.stdin.write('first-history-entry\n');
        return;
      }
      if (sentFirst && !sentSecond && output.includes('ANSWER-1') && promptCount >= 2) {
        sentSecond = true;
        child.stdin.write('second-history-entry\n');
        return;
      }
      if (sentSecond && !sentHistoryUp && output.includes('ANSWER-2') && promptCount >= 3) {
        sentHistoryUp = true;
        firstHistoryUpOffset = output.length;
        child.stdin.write('\x1b[A');
        return;
      }
      if (sentHistoryUp && !sentInterrupt &&
        output.slice(firstHistoryUpOffset).includes('second-history-entry')) {
        sentInterrupt = true;
        child.stdin.write('\x03');
        return;
      }
      if (sentInterrupt && !sentHistoryUpAgain &&
        output.includes('Press Ctrl+C again to exit.')) {
        sentHistoryUpAgain = true;
        secondHistoryUpOffset = output.length;
        child.stdin.write('\x1b[A');
        return;
      }
      if (sentHistoryUpAgain && !sentExit) {
        const recalled = output.slice(secondHistoryUpOffset);
        if (recalled.includes('second-history-entry') ||
          recalled.includes('first-history-entry')) {
          historyResetVerified = recalled.includes('second-history-entry') &&
            !recalled.includes('first-history-entry');
          sentExit = true;
          // Clear whichever history entry was recalled, then exit normally.
          child.stdin.write('\x15/exit\n');
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, output + stderr);
    assert.equal(status, 0, output + stderr);
    assert.equal(sentFirst, true, output + stderr);
    assert.equal(sentSecond, true, output + stderr);
    assert.equal(sentHistoryUp, true, output + stderr);
    assert.equal(sentInterrupt, true, output + stderr);
    assert.equal(sentHistoryUpAgain, true, output + stderr);
    assert.equal(sentExit, true, output + stderr);
    assert.equal(historyResetVerified, true,
      'Ctrl+C must reset readline history so Up recalls the newest entry: ' + output + stderr);
    assert.equal(requests.length, 2, 'history navigation must not submit another model request');
    assert.equal(output.includes('fixture-ctrlc-history-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
