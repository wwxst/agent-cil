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
const start = () => frame('message_start', { message: { usage: { input_tokens: 10 } } });
const ended = reason => frame('message_delta', { delta: { stop_reason: reason } }) +
  frame('message_stop');
const original = 'module.exports = (a, b) => a - b;\n';
const fixed = 'module.exports = (a, b) => a + b;\n';

function toolStream(n) {
  const useEdit = n === 3, id = (useEdit ? 'edit-' : 'read-') + n;
  const input = useEdit
    ? { file_path: 'math.cjs', old_string: 'a - b', new_string: 'a + b' }
    : { file_path: n === 2 ? 'math.cjs' : 'notes.txt' };
  return start() +
    frame('content_block_start', { index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'thinking_delta', thinking: 'private thought round ' + n } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'signature_delta', signature: 'sig-' + n } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('content_block_start', { index: 1,
      content_block: { type: 'tool_use', id, name: useEdit ? 'Edit' : 'Read', input: {} } }) +
    frame('content_block_delta', { index: 1,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    frame('content_block_stop', { index: 1 }) + ended('tool_use');
}
function textStream(text) {
  return start() + frame('content_block_start', { index: 0,
    content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    frame('content_block_stop', { index: 0 }) + ended('end_turn');
}

test('installed DeepSeek CLI: 3 tools incl Edit, context 400, summary and one safe final retry', {
  timeout: 27000,
}, async () => {
  const work = await mkdtemp(join(tmpdir(), 'agent-cil-reactive-'));
  const requests = [], notes = 'read project notes\n'.repeat(180);
  const server = createServer(async (req, res) => {
    const input = [];
    for await (const buffer of req) input.push(buffer);
    requests.push(JSON.parse(Buffer.concat(input).toString('utf8')));
    const count = requests.length;
    if (count === 4) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 1400 tokens > 1000 maximum',
      } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count <= 3) res.end(toolStream(count));
    else if (count === 5) {
      res.end(textStream('Earlier project Read was completed. An Edit fixed math.cjs.'));
    } else res.end(textStream('Recovery succeeded without replaying Edit.'));
  });
  let child, watchdog;
  try {
    await writeFile(join(work, 'math.cjs'), original);
    await writeFile(join(work, 'notes.txt'), notes);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    child = spawn(process.execPath, [
      cli, '--print', '--provider', 'deepseek', '--allow-edits',
      '--cwd', work, '--max-turns', '6', '--max-retries', '0',
      '--compact-threshold', '500000',
      '--base-url', 'http://127.0.0.1:' + addr.port + '/anthropic',
      'Read notes, fix math.cjs, then explain.',
    ], { env: { ...process.env, DEEPSEEK_API_KEY: 'local-only-fixture-key' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, sig) => resolve([status, sig]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'Recovery succeeded without replaying Edit.');
    assert.equal(requests.length, 6, '3 tools, 1 rejected request, 1 summary, 1 retry');
    assert.equal(requests[0].messages[0].content, 'Read notes, fix math.cjs, then explain.');
    assert.deepEqual(requests[3].tools?.map(t => t.name), requests[0].tools?.map(t => t.name));
    assert.equal(requests[4].tools, undefined, 'compaction never grants model tools');
    assert.match(requests[5].messages[0].content, /Earlier project Read was completed/);
    // The second source Read now opens the actual file being edited,
    // satisfying FileEditTool's original pre-edit readFileState contract.
    assert.equal(requests[2].messages.at(-1).content[0].tool_use_id,'read-2');
    assert.equal(requests[5].messages[1].content[0].signature, 'sig-2');
    assert.equal(requests[5].messages[3].content[0].signature, 'sig-3');
    assert.equal(requests[5].messages[3].content[1].id, 'edit-3');
    assert.equal(requests[5].messages[4].content[0].tool_use_id, 'edit-3');
    assert.equal(JSON.parse(requests[5].messages[4].content[0].content).edited, true);
    assert.deepEqual(requests[5].messages[requests[5].messages.length - 1].content,
      requests[3].messages.at(-1).content);
    assert.equal(await readFile(join(work, 'math.cjs'), 'utf8'), fixed);
    assert.equal((stderr.match(/\[tool\] Edit/g) || []).length, 1);
    assert.equal(stdout.includes('private thought'), false);
    assert.equal(stderr.includes('local-only-fixture-key'), false);
    assert.match(stderr, /\[context\] compacted/);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(work, { recursive: true, force: true });
  }
});
