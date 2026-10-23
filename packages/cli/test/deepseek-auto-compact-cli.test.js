import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, fields = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
const start = () => frame('message_start', { message: { usage: { input_tokens: 8 } } });
const end = reason => frame('message_delta', { delta: { stop_reason: reason } }) +
  frame('message_stop');
function toolStream(index) {
  const id = 'read-' + index;
  return start() +
    frame('content_block_start', { index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    frame('content_block_delta', { index: 0, delta: {
      type: 'thinking_delta', thinking: 'private plan ' + index,
    } }) +
    frame('content_block_delta', { index: 0, delta: {
      type: 'signature_delta', signature: 'opaque-sig-' + index,
    } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('content_block_start', { index: 1,
      content_block: { type: 'tool_use', id, name: 'Read', input: {} } }) +
    frame('content_block_delta', { index: 1, delta: {
      type: 'input_json_delta', partial_json: '{"file_path":"big.txt"}',
    } }) +
    frame('content_block_stop', { index: 1 }) + end('tool_use');
}
function textStream(text) {
  return start() +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    frame('content_block_stop', { index: 0 }) + end('end_turn');
}

test('packed DeepSeek CLI automatically summarizes old tool rounds with signed recent turns preserved', {
  timeout: 25000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-autocompact-'));
  const requests = [];
  const bigText = 'Old project diagnostic result.\n'.repeat(90);
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const json = JSON.parse(Buffer.concat(parts).toString('utf8'));
    requests.push(json);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const count = requests.length;
    if (count <= 3) res.end(toolStream(count));
    else if (count === 4) {
      assert.equal(json.tools === undefined || json.tools.length === 0, true);
      res.end(textStream('Earlier old project reads completed; continue with fresh results.'));
    } else res.end(textStream('Final response after compaction.'));
  });
  let child, watchdog;
  try {
    await writeFile(join(workspace, 'big.txt'), bigText);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    child = spawn(process.execPath, [
      cli, '--print', '--provider', 'deepseek',
      '--base-url', 'http://127.0.0.1:' + port + '/anthropic',
      '--model', 'deepseek-flash', '--max-retries', '0',
      '--compact-threshold', '400', '--cwd', workspace,
      'Read the project diagnostics and complete the task.',
    ], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'local-compaction-test-only' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, sig] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    assert.equal(sig, null, stderr);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'Final response after compaction.');
    assert.match(stderr, /\[context\] compacted/);
    assert.equal(requests.length, 5, '3 Read turns, 1 summary call, 1 final answer');
    assert.equal(requests[3].messages[0].content, 'Read the project diagnostics and complete the task.');
    assert.equal(requests[4].messages[0].role, 'user');
    assert.match(requests[4].messages[0].content, /Earlier old project reads completed/);
    assert.equal(requests[4].messages[1].content[0].signature, 'opaque-sig-2');
    assert.equal(requests[4].messages[3].content[0].signature, 'opaque-sig-3');
    assert.deepEqual(requests[4].messages.filter(x => x.role === 'assistant')
      .flatMap(x => x.content.filter(b => b.type === 'tool_use').map(b => b.id)),
    ['read-2', 'read-3']);
    assert.equal(requests[4].messages[2].content[0].content, bigText);
    assert.equal(requests[4].messages[4].content[0].content, bigText);
    assert.equal(stdout.includes('private plan'), false);
    assert.equal(stderr.includes('local-compaction-test-only'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
