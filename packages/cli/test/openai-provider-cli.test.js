import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseArgs } from '../src/index.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ||
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const event = chunk => 'data: ' + JSON.stringify(chunk) + '\n\n';
const chunk = (delta, finish_reason = null) => ({
  object: 'chat.completion.chunk', id: 'test-stream',
  choices: [{ index: 0, delta, finish_reason }],
});
const done = 'data: [DONE]\n\n';
function toolStream(tools) {
  return [
    event(chunk({ role: 'assistant' })),
    ...tools.map(([id, name, input], index) => event(chunk({
      tool_calls: [{ index, id, type: 'function',
        function: { name, arguments: JSON.stringify(input) } }],
    }))),
    event(chunk({}, 'tool_calls')), done,
  ].join('');
}
function textStream(text) {
  return event(chunk({ content: text })) + event(chunk({}, 'stop')) + done;
}

test('CLI selects OpenAI, DeepSeek and Anthropic explicitly, never inferring from API keys', () => {
  assert.equal(parseArgs(['--provider', 'openai', '--model', 'gpt-5.1', 'hello']).provider, 'openai');
  assert.equal(parseArgs(['--provider=deepseek', 'hello']).provider, 'deepseek');
  assert.equal(parseArgs(['hello']).provider, 'anthropic');
  assert.throws(() => parseArgs(['--provider', 'unknown', 'hello']), /--provider/);
});

test('OpenAI Chat end-to-end: Read, failing Bash test, Edit, passing Bash test, Read', {
  timeout: 25000,
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-openai-coding-'));
  const requests = [];
  const original = 'module.exports = (a, b) => a - b;\n';
  const expected = 'module.exports = (a, b) => a + b;\n';
  const first = toolStream([
    ['read-initial', 'Read', { file_path: 'math.cjs' }],
    ['test-fail', 'Bash', { command: 'node test.cjs' }],
    ['repair-code', 'Edit', { file_path: 'math.cjs',
      old_string: 'a - b', new_string: 'a + b' }],
    ['test-pass', 'Bash', { command: 'node test.cjs' }],
    ['read-final', 'Read', { file_path: 'math.cjs' }],
  ]);
  const second = textStream('Fixed and tested successfully.');
  const server = createServer(async (request, response) => {
    const buf = [];
    for await (const bytes of request) buf.push(bytes);
    requests.push(JSON.parse(Buffer.concat(buf).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(requests.length === 1 ? first : second);
  });
  let child;
  let watchdog;
  try {
    await writeFile(join(workspace, 'math.cjs'), original);
    await writeFile(join(workspace, 'test.cjs'),
      "const assert = require('node:assert/strict');\n" +
      "assert.equal(require('./math.cjs')(2,3),5);\n" +
      "console.log('TEST PASSED');\n");
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const a = server.address();
    const quoted = arg => "'" + arg.replaceAll("'", "'\\''") + "'";
    child = spawn('script', [
      '-q', '-e', '-c',
      [
        process.execPath, cli, '--provider', 'openai', '--allow-edits',
        '--model', 'gpt-5.1', '--max-retries', '0', '--max-turns', '3',
        '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + a.port + '/v1',
        'Fix the code and test it.',
      ].map(quoted).join(' '), '/dev/null',
    ], {
      env: { ...process.env, OPENAI_API_KEY: 'local-test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let combined = '';
    let approvals = 0;
    let exits = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      combined += data;
      const prompts = (combined.match(/Approve this tool call\? \[y\/N\] /g) || []).length;
      if (prompts > approvals) {
        approvals += 1;
        child.stdin.write('y\n');
      }
      if (combined.includes('you> ') && exits === 0) {
        exits++;
        child.stdin.write('/exit\n');
      }
    });
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { errors += data; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
    const [status, sig] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve([code, signal]));
    });
    assert.equal(status, 0, combined + errors);
    assert.equal(sig, null, combined + errors);
    assert.equal(approvals, 2, combined + errors);
    assert.equal(exits, 1, combined + errors);
    assert.match(combined, /Fixed and tested successfully/);
    assert.equal(await readFile(join(workspace, 'math.cjs'), 'utf8'), expected);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, 'gpt-5.1');
    assert.equal(requests[0].tools.length, 6);
    assert.deepEqual(requests[1].messages.map(m => m.role), [
      'user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'tool',
    ]);
    const results = requests[1].messages.filter(m => m.role === 'tool');
    assert.equal(results[0].content, original);
    assert.equal(results[4].content, expected);
    assert.equal(JSON.parse(results[1].content).exit_code, 1);
    assert.equal(JSON.parse(results[3].content).exit_code, 0);
    assert.match(JSON.parse(results[3].content).stdout, /TEST PASSED/);
    assert.equal(JSON.parse(results[2].content).edited, true);
    assert.equal(combined.includes('local-test-key'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});


test('DeepSeek provider selects official Anthropic protocol and returns Read tool output', {
  timeout: 16000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-deepseek-provider-'));
  const incoming = [];
  const sse = (type, value = {}) => 'event: ' + type + '\n' +
    'data: ' + JSON.stringify({ type, ...value }) + '\n\n';
  const first = [
    sse('message_start', { message: { usage: { input_tokens: 5 } } }),
    sse('content_block_start', { index: 0, content_block: {
      type: 'tool_use', id: 'ds-read', name: 'Read', input: {},
    } }),
    sse('content_block_delta', { index: 0, delta: {
      type: 'input_json_delta', partial_json: '{"file_path":"test.txt"}',
    } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sse('message_stop'),
  ].join('');
  const final = [
    sse('message_start', { message: { usage: { input_tokens: 7 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'DeepSeek reading completed.' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
  const server = createServer(async (req, res) => {
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    incoming.push({
      url: req.url, key: req.headers['x-api-key'],
      body: JSON.parse(Buffer.concat(pieces).toString('utf8')),
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(incoming.length === 1 ? first : final);
  });
  let child;
  let kill;
  try {
    await writeFile(join(workspace, 'test.txt'), 'DeepSeek workspace data\n');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const a = server.address();
    child = spawn(process.execPath, [
      cli, '--provider', 'deepseek', '--print', '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + a.port + '/anthropic',
      '--max-retries', '0', 'Read test.txt',
    ], { env: { ...process.env,
      DEEPSEEK_API_KEY: 'local-deepseek-fixture',
      ANTHROPIC_API_KEY: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', x => { out += x; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', x => { err += x; });
    kill = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [code, sig] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    assert.equal(sig, null, err);
    assert.equal(code, 0, err);
    assert.equal(out.trim(), 'DeepSeek reading completed.');
    assert.equal(incoming.length, 2);
    assert.equal(incoming[0].url, '/anthropic/v1/messages');
    assert.equal(incoming[0].key, 'local-deepseek-fixture');
    assert.equal(incoming[0].body.model, 'deepseek-flash');
    assert.equal(incoming[1].body.messages.at(-1).content[0].content,
      'DeepSeek workspace data\n');
    assert.equal(out.includes('local-deepseek-fixture'), false);
  } finally {
    if (kill) clearTimeout(kill);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
