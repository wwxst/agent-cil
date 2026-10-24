import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, props = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...props }) + '\n\n';
function start(inputTokens) {
  return frame('message_start', { message: { usage: {
    input_tokens: inputTokens, output_tokens: 0,
    cache_creation_input_tokens: 20, cache_read_input_tokens: 10,
  } } });
}
const stop = reason => frame('message_delta', {
  delta: { stop_reason: reason }, usage: { output_tokens: 10 },
}) + frame('message_stop');
function readRound(n) {
  return start(n === 3 ? 1800 : 45) +
    frame('content_block_start', { index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'signature_delta', signature: 'signed-' + n } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('content_block_start', { index: 1,
      content_block: { type: 'tool_use', id: 'read-' + n, name: 'Read', input: {} } }) +
    frame('content_block_delta', { index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: 'note.txt' }) } }) +
    frame('content_block_stop', { index: 1 }) + stop('tool_use');
}
function answer(value) {
  return start(25) + frame('content_block_start', { index: 0,
    content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'text_delta', text: value } }) +
    frame('content_block_stop', { index: 0 }) + stop('end_turn');
}

test('installed CLI uses real API usage to trigger tool-free compaction instead of text size', {
  timeout: 22000,
}, async () => {
  const work = await mkdtemp(join(tmpdir(), 'agent-cil-real-usage-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const n = requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(n <= 3 ? readRound(n) : answer(n === 4
      ? 'Completed earlier reads and reviewed project history.'
      : 'Summary retained and final answer complete.'));
  });
  let child, watchdog;
  try {
    await writeFile(join(work, 'note.txt'), 'tiny document\n');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    child = spawn(process.execPath, [cli, '--print', '--provider', 'deepseek',
      '--compact-threshold', '1200', '--max-turns', '6', '--max-retries', '0',
      '--cwd', work, '--base-url',
      'http://127.0.0.1:' + server.address().port + '/anthropic',
      'Read note.txt three times, then summarize progress.'], {
      env: { ...process.env, DEEPSEEK_API_KEY: 'only-local-api-token-test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', value => stdout.push(value));
    child.stderr.on('data', value => stderr.push(value));
    watchdog = setTimeout(() => child.kill('SIGKILL'), 14000);
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, sig) => resolve([status, sig]));
    });
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    assert.equal(signal, null, out + err);
    assert.equal(code, 0, out + err);
    assert.match(out, /Summary retained and final answer complete/);
    assert.equal(requests.length, 5, '3 Reads, 1 tool-free summary, 1 final request');
    assert.equal(requests[3].tools, undefined, 'summary request must never expose tools');
    assert.deepEqual(requests[0].tools?.map(t => t.name),
      requests[2].tools?.map(t => t.name));
    assert.equal(requests[4].messages[0].role, 'user');
    assert.match(requests[4].messages[0].content, /Completed earlier reads/);
    assert.equal(requests[4].messages[1].content[0].signature, 'signed-2');
    assert.equal(requests[4].messages[3].content[0].signature, 'signed-3');
    assert.equal(requests[4].messages[4].content[0].tool_use_id, 'read-3');
    assert.match(err, /\[context\] compacted/);
    assert.equal(err.includes('only-local-api-token-test'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
