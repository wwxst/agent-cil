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
const sse = (type, extra = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...extra }) + '\n\n';
const start = () => sse('message_start', { message: { usage: { input_tokens: 1 } } });
const stop = reason => sse('message_delta', { delta: { stop_reason: reason } }) + sse('message_stop');
function editStream() {
  return start() +
    sse('content_block_start', { index: 0, content_block: {
      type: 'thinking', thinking: '', signature: '' } }) +
    sse('content_block_delta', { index: 0,
      delta: { type: 'thinking_delta', thinking: 'private reasoning' } }) +
    sse('content_block_delta', { index: 0,
      delta: { type: 'signature_delta', signature: 'original-signature' } }) +
    sse('content_block_stop', { index: 0 }) +
    sse('content_block_start', { index: 1, content_block: {
      type: 'tool_use', id: 'edit-once', name: 'Edit', input: {} } }) +
    sse('content_block_delta', { index: 1, delta: {
      type: 'input_json_delta', partial_json: JSON.stringify({
        file_path: 'math.js', old_string: 'a - b', new_string: 'a + b',
      }) } }) +
    sse('content_block_stop', { index: 1 }) + stop('tool_use');
}
function textStream(text) {
  return start() + sse('content_block_start', { index: 0,
    content_block: { type: 'text', text: '' } }) +
    sse('content_block_delta', { index: 0,
      delta: { type: 'text_delta', text } }) +
    sse('content_block_stop', { index: 0 }) + stop('end_turn');
}

test('TTY CLI retries after post-Edit model failure with completed tool history, without repeating Edit', {
  timeout: 26000,
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-turn-recovery-'));
  const requests = [], oldText = 'const add = (a,b) => a - b;\n';
  const fixedText = 'const add = (a,b) => a + b;\n';
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const b of req) body.push(b);
    requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
    if (requests.length === 2) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model temporarily unavailable' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(requests.length === 1 ? editStream() : textStream('Continued safely.'));
  });
  const q = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let child, watchdog;
  try {
    await writeFile(join(workspace, 'math.js'), oldText);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    child = spawn('script', ['-q', '-e', '-c', [
      process.execPath, cli, '--allow-edits', '--max-retries', '0',
      '--max-turns', '4', '--provider', 'deepseek',
      '--cwd', workspace, '--base-url',
      'http://127.0.0.1:' + addr.port + '/anthropic',
      'Fix math.js once.',
    ].map(q).join(' '), '/dev/null'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'fake-recovery-test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', errors = '', sent = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => {
      output += value;
      const prompts = (output.match(/you> /g) || []).length;
      if (prompts > sent) {
        sent = prompts;
        if (sent === 1) child.stdin.write('continue\n');
        if (sent === 2) child.stdin.write('/exit\n');
      }
    });
    child.stderr.on('data', value => { errors += value; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(signal, null, output + errors);
    assert.equal(status, 0, output + errors);
    assert.equal(sent, 2, output + errors);
    assert.match(output, /\[recovery\] Completed tool results were retained/);
    assert.match(output, /Continued safely\./);
    assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), fixedText);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].messages[0].content, 'Fix math.js once.');
    assert.equal(requests[1].messages[1].content[0].type, 'thinking');
    assert.equal(requests[1].messages[1].content[0].signature, 'original-signature');
    assert.equal(requests[1].messages[1].content[1].id, 'edit-once');
    assert.equal(requests[1].messages[2].content[0].tool_use_id, 'edit-once');
    assert.equal(requests[2].messages.length, 4);
    assert.deepEqual(requests[2].messages.slice(0, 3), requests[1].messages);
    assert.equal(requests[2].messages.at(-1).content, 'continue');
    assert.equal((output.match(/\[tool\] Edit/g) || []).length, 1);
    assert.equal(output.includes('private reasoning'), false);
    assert.equal(errors.includes('fake-recovery-test-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
