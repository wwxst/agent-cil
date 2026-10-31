import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, props = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...props }) + '\n\n';
function toolReply(name, id, input) {
  return frame('message_start', { message: { usage: { input_tokens: 15 } } }) +
    frame('content_block_start', { index: 0,
      content_block: { type: 'tool_use', id, name, input: {} } }) +
    frame('content_block_delta', { index: 0, delta: {
      type: 'input_json_delta', partial_json: JSON.stringify(input),
    } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }) +
    frame('message_stop');
}
function finish(text) {
  return frame('message_start', { message: { usage: { input_tokens: 20 } } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }) +
    frame('message_stop');
}

test('real CLI: Grep persists above its original 20K threshold; model reads exact file through original preview', {
  timeout: 24000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-storage-cli-'));
  const text = Array.from({ length: 50 }, (_, i) =>
    'ORIGINAL_RESULT ' + String(i).padStart(3, '0') + ' ' + 'z'.repeat(450)).join('\n');
  const requests = [];
  let persistedPath;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      res.end(toolReply('Grep', 'big-grep-result',
        { pattern: 'ORIGINAL_RESULT', path: 'source.txt' }));
    } else if (requests.length === 2) {
      const block = body.messages.at(-1).content[0];
      assert.equal(block.tool_use_id, 'big-grep-result');
      assert.match(block.content, /^<persisted-output>/);
      const found = /Full output saved to: ([^\n]+)/.exec(block.content);
      assert.ok(found, 'original preview must include full result location');
      persistedPath = found[1];
      res.end(toolReply('Read', 'read-saved-result', { file_path: persistedPath }));
    } else {
      const block = body.messages.at(-1).content[0];
      assert.equal(block.tool_use_id, 'read-saved-result');
      assert.equal(block.is_error, undefined);
      assert.ok(block.content.includes('ORIGINAL_RESULT 049'));
      assert.ok(block.content.length > 20_000);
      res.end(finish('Restored full Grep output from persisted file.'));
    }
  });
  let child, watchdog;
  try {
    await writeFile(join(workspace, 'source.txt'), text);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    child = spawn(process.execPath, [
      cli, '--print', '--provider', 'deepseek', '--compact-threshold', '0',
      '--cwd', workspace, '--max-turns', '5', '--max-retries', '0',
      '--base-url', 'http://127.0.0.1:' + port + '/anthropic',
      'Find all ORIGINAL_RESULT lines, inspect saved result, then answer.',
    ], { env: { ...process.env, DEEPSEEK_API_KEY: 'fixture-not-a-real-credential' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    assert.equal(signal, null, out + err);
    assert.equal(status, 0, out + err);
    assert.equal(requests.length, 3);
    assert.match(out, /Restored full Grep output/);
    const saved = await readFile(persistedPath, 'utf8');
    assert.ok(saved.length > 20_000);
    assert.ok(saved.includes('ORIGINAL_RESULT 049'));
    assert.ok(persistedPath.includes('tool-results'));
    const dirs = await readdir(join(workspace, '.agent-cil', 'sessions'));
    assert.equal(dirs.length, 1, 'one session directory per CLI invocation');
    assert.equal((err.match(/\[tool\] Grep/g) || []).length, 1);
    assert.equal((err.match(/\[tool\] Read/g) || []).length, 1);
    assert.equal(err.includes('fixture-not-a-real-credential'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
});
