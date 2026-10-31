import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ||
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, props = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...props }) + '\n\n';
const open = (index, content_block) => frame('content_block_start', { index, content_block });
const delta = (index, change) => frame('content_block_delta', { index, delta: change });
const stop = index => frame('content_block_stop', { index });
const completed = reason => frame('message_delta', { delta: { stop_reason: reason } }) +
  frame('message_stop');
const started = () => frame('message_start', { message: { usage: { input_tokens: 4 } } });

function readAndEditPrefix() {
  return started() +
    open(0, { type: 'thinking', thinking: '' }) +
    delta(0, { type: 'thinking_delta', thinking: 'private model planning' }) +
    delta(0, { type: 'signature_delta', signature: 'untouched-signed-block' }) +
    stop(0) +
    open(1, { type: 'tool_use', id: 'stream-read', name: 'Read', input: {} }) +
    delta(1, { type: 'input_json_delta', partial_json: '{"file_path":"math.js"}' }) +
    stop(1) +
    open(2, { type: 'tool_use', id: 'deferred-edit', name: 'Edit', input: {} }) +
    delta(2, { type: 'input_json_delta',
      partial_json: '{"file_path":"math.js","old_string":"a - b","new_string":"a + b"}' }) +
    stop(2);
}
function finalText() {
  return started() + open(0, { type: 'text', text: '' }) +
    delta(0, { type: 'text_delta', text: 'Repaired successfully.' }) +
    stop(0) + completed('end_turn');
}

/**
 * This is a true CLI process and real filesystem Read/Edit, not a fake
 * AgentLoop. The local SSE server intentionally withholds message_stop
 * until the child reports that Read has started.
 */
async function runScenario({ invalidAfterRead }) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-early-sse-'));
  const original = 'const sum = (a, b) => a - b;\n';
  const expected = 'const sum = (a, b) => a + b;\n';
  const bodies = [];
  let initialResponse;
  let startedRead = false;
  let startedEditBeforeEnd = false;
  let streamEnded = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push({ path: req.url, content: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    if (bodies.length === 1) {
      initialResponse = res;
      res.write(readAndEditPrefix());
    } else {
      res.end(finalText());
    }
  });
  let child, watchdog;
  try {
    await writeFile(join(workspace, 'math.js'), original);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    child = spawn(process.execPath, [
      cli, '--print', '--allow-edits', '--model', 'deepseek-flash',
      '--base-url', 'http://127.0.0.1:' + addr.port + '/anthropic',
      '--cwd', workspace, '--max-retries', '0', 'Read then fix math.js.',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ANTHROPIC_API_KEY: 'local-early-streaming-fixture' },
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (!startedRead && stderr.includes('[tool] Read')) {
        startedRead = true;
        // Do not send message_stop until Read really starts. If execution
        // remains post-stream, the watchdog kills this test as a failure.
        if (initialResponse && !streamEnded) {
          startedEditBeforeEnd = stderr.includes('[tool] Edit');
          if (invalidAfterRead) {
            initialResponse.end(frame('unrecognized_SSE_event'));
          } else {
            initialResponse.end(completed('tool_use'));
          }
          streamEnded = true;
        }
      }
      if (!streamEnded && stderr.includes('[tool] Edit')) startedEditBeforeEnd = true;
    });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(startedRead, true, 'Read never began before SSE message_stop: ' + stderr);
    assert.equal(startedEditBeforeEnd, false, 'Edit ran before model stream completion.');
    assert.equal(streamEnded, true);
    if (invalidAfterRead) {
      assert.notEqual(status, 0, 'malformed SSE must exit with error');
      assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), original);
      assert.equal(bodies.length, 1, 'invalid model response must never get tool_result follow-up');
    } else {
      assert.equal(status, 0, stderr);
      assert.equal(stdout.trim(), 'Repaired successfully.');
      assert.equal(stdout.includes('private model planning'), false);
      assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), expected);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].path, '/anthropic/v1/messages');
      assert.deepEqual(bodies[1].content.messages[1].content[0], {
        type: 'thinking', thinking: 'private model planning',
        signature: 'untouched-signed-block',
      });
      const results = bodies[1].content.messages.at(-1).content;
      assert.deepEqual(results.map(result => result.tool_use_id),
        ['stream-read', 'deferred-edit']);
      assert.equal(results[0].content, original);
      assert.equal(JSON.parse(results[1].content).edited, true);
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
}
test('CLI DeepSeek SSE begins Read before message_stop while delaying Edit until completion', {
  timeout: 16000,
}, async () => runScenario({ invalidAfterRead: false }));
test('CLI DeepSeek SSE protocol failure after early Read never executes deferred Edit', {
  timeout: 16000,
}, async () => runScenario({ invalidAfterRead: true }));
