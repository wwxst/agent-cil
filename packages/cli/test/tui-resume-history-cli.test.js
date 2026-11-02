import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { openSessionJournal } from '../../runtime/src/legacy-session/session-storage.js';
import { normalizeTuiOutput } from './tui-test-helpers.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('real Ink TUI restores the committed conversation when resuming a session', {
  timeout: 25000,
  skip: process.platform === 'win32' && 'util-linux script PTY is for Linux; Windows runs the native ConPTY harness',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-tui-resume-history-'));
  const sessionId = 'e5b2e09e-4f39-4ad9-bb2d-0dfeaaab1d12';
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('');
  });
  let journal;
  let child;
  let watchdog;
  try {
    journal = await openSessionJournal({ workspace, sessionId });
    const user = { role: 'user', content: 'What did we decide in the previous turn?' };
    const assistant = { role: 'assistant', content: 'We decided to keep the original AgentLoop.' };
    await journal.append({ messages: [user], kind: 'input' });
    await journal.append({ messages: [user, assistant], kind: 'finished' });
    await journal.close();
    journal = undefined;

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const args = [
      process.execPath, cli, '--resume', sessionId, '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + address.port,
      '--max-retries', '0',
    ];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    child = spawn('script', ['-q', '-e', '-c', args.map(quote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'tui-resume-history-fixture', LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let exitSent = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      const visible = normalizeTuiOutput(output).replace(/\s+/g, '');
      if (!exitSent && visible.includes('previousturn?') &&
          visible.includes('originalAgentLoop.') && visible.includes('you>')) {
        exitSent = true;
        child.stdin.write('/exit\r');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(status, 0, stderr + output);
    assert.equal(exitSent, true, stderr + output);
    const visible = normalizeTuiOutput(output).replace(/\s+/g, '');
    assert.ok(visible.indexOf('previousturn?') < visible.indexOf('originalAgentLoop.'));
    assert.equal(requests.length, 0, 'promptless interactive resume only restores the transcript; it must not invent a model request');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    if (journal) await journal.close();
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
