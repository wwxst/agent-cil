import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));

const frame = (type, props = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...props }) + '\n\n';
const start = () => frame('message_start', {
  message: { usage: { input_tokens: 15, output_tokens: 1 } },
});
const stop = reason => frame('message_delta', {
  delta: { stop_reason: reason }, usage: { output_tokens: 10 },
}) + frame('message_stop');
function editRound() {
  return start() +
    frame('content_block_start', { index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'signature_delta', signature: 'signed-session-result' } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('content_block_start', { index: 1,
      content_block: { type: 'tool_use', id: 'edit-session-once', name: 'Edit', input: {} } }) +
    frame('content_block_delta', { index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({
        file_path: 'math.js', old_string: 'a - b', new_string: 'a + b',
      }) } }) +
    frame('content_block_stop', { index: 1 }) + stop('tool_use');
}
function finalRound(text) {
  return start() +
    frame('content_block_start', { index: 0,
      content_block: { type: 'text', text } }) +
    frame('content_block_stop', { index: 0 }) + stop('end_turn');
}

async function cliRun(args, env) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', x => stdout.push(x));
  child.stderr.on('data', x => stderr.push(x));
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, sig) => resolve([status, sig]));
    });
    return {
      code, signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };
  } finally {
    clearTimeout(watchdog);
  }
}

test('real CLI persists completed Edit and tool_result after model 503, resumes without replay', {
  timeout: 24000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-session-cli-'));
  const sessionDir = join(workspace, 'sessions');
  const initial = 'const add=(a,b)=>a - b;\n';
  const fixed = 'const add=(a,b)=>a + b;\n';
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (requests.length === 2) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'temporary upstream outage' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(requests.length === 1
      ? editRound() : finalRound('Recovered previous Edit safely.'));
  });
  try {
    await writeFile(join(workspace, 'math.js'), initial);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const common = ['--print', '--allow-edits', '--max-retries', '0',
      '--provider', 'deepseek', '--compact-threshold', '0',
      '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + port + '/anthropic'];
    const env = { DEEPSEEK_API_KEY: 'test-key-only', AGENT_CIL_SESSION_DIR: sessionDir };

    const one = await cliRun([...common, '--session', 'review-p1', 'Fix math.js once'], env);
    assert.equal(one.signal, null, one.stderr);
    assert.equal(one.code, 1, 'provider outage after Edit must fail the first invocation');
    assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), fixed);
    const saved = JSON.parse(await readFile(join(sessionDir, 'review-p1.json'), 'utf8'));
    assert.equal(saved.turns[0].status, 'failed');
    assert.equal(saved.messages.length, 3, 'completed assistant and tool results must survive');
    assert.equal(saved.messages[1].content[0].signature, 'signed-session-result');
    assert.equal(saved.messages[1].content[1].id, 'edit-session-once');
    assert.equal(saved.messages[2].content[0].tool_use_id, 'edit-session-once');

    const duplicate = await cliRun([...common, '--session', 'review-p1', 'overwrite'], env);
    assert.equal(duplicate.code, 2, duplicate.stderr);
    assert.match(duplicate.stderr, /Session already exists/);
    assert.equal(requests.length, 2, 'duplicate session must fail before API call');

    const two = await cliRun([...common, '--resume', 'review-p1', 'Continue, no re-edit'], env);
    assert.equal(two.signal, null, two.stderr);
    assert.equal(two.code, 0, two.stderr);
    assert.match(two.stdout, /Recovered previous Edit safely/);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].messages.slice(0, 3), requests[1].messages.slice(0, 3));
    assert.equal(requests[2].messages.at(-1).content, 'Continue, no re-edit');
    assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), fixed);
    const restored = JSON.parse(await readFile(join(sessionDir, 'review-p1.json'), 'utf8'));
    assert.equal(restored.turns[1].status, 'completed');
    assert.equal(restored.messages.length, 5);
    assert.equal(two.stderr.includes('test-key-only'), false);

    const otherDir = await mkdtemp(join(tmpdir(), 'agent-cil-session-different-'));
    try {
      const wrong = await cliRun([...common, '--cwd', otherDir,
        '--resume', 'review-p1', 'should not run'], env);
      assert.equal(wrong.code, 2, wrong.stderr);
      assert.match(wrong.stderr, /different workspace or provider/);
      assert.equal(requests.length, 3);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
});

test('CLI session argument validation rejects IDs that could escape the store', async () => {
  const result = await cliRun(['--session', '../escape', '--print', 'hello'], {});
  assert.equal(result.code, 2);
  assert.match(result.stderr, /valid session ID/);
  const both = await cliRun(['--session', 's1', '--resume', 's2', '--print', 'hi'], {});
  assert.equal(both.code, 2);
  assert.match(both.stderr, /cannot be combined/);
});
