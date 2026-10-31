import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
// These pre-Ink acceptance cases verify the real original readline fallback.
// Ink is the default CLI and has separate Linux PTY / Windows ConPTY cases.
process.env.AGENT_CIL_TUI = 'readline';
import { fileURLToPath } from 'node:url';

// CI re-runs these acceptance cases against the freshly installed npm bin.
const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const sse = (type, fields = {}) => 'event: ' + type + '\n' +
  'data: ' + JSON.stringify({ type, ...fields }) + '\n\n';
const toolStream = blocks => [
  sse('message_start', { message: { usage: { input_tokens: 2 } } }),
  ...blocks.flatMap(([id, name, input], index) => [
    sse('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    sse('content_block_stop', { index }),
  ]),
  sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
  sse('message_stop'),
].join('');
const finishStream = text => [
  sse('message_start', { message: { usage: { input_tokens: 2 } } }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
  sse('message_stop'),
].join('');

test('CLI retries a disconnected pre-response fetch, then runs Read and continues', {
  timeout: 18000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-legacy-transport-'));
  const requests = [];
  const first = toolStream([['first-read', 'Read', { file_path: 'file.txt' }]]);
  const last = finishStream('Recovered connection; checked file.');
  const server = createServer(async (req, res) => {
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    requests.push(JSON.parse(Buffer.concat(bytes).toString('utf8')));
    if (requests.length === 1) {
      req.socket.destroy(); // fetch/undici yields TypeError before HTTP headers
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(requests.length === 2 ? first : last);
  });
  let child;
  let watchdog;
  try {
    await writeFile(join(workspace, 'file.txt'), 'pre-response retry validated\n');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    child = spawn(process.execPath, [
      cli, '--print', '--max-retries', '1', '--cwd', workspace,
      '--base-url', 'http://127.0.0.1:' + address.port,
      '--model', 'retry-fixture', 'Read file.txt.',
    ], { env: { ...process.env, ANTHROPIC_API_KEY: 'fake-credential' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, sig) => resolve([status, sig]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'Recovered connection; checked file.');
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[0], requests[1], 'retry cannot rewrite the requested messages');
    assert.equal(requests[2].messages.at(-1).content[0].content, 'pre-response retry validated\n');
    assert.equal(stderr.includes('fake-credential'), false);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('interactive TTY CLI can read, edit, approve Bash verification and reread in one turn', {
  timeout: 24000,
  skip: process.platform === 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-coding-acceptance-'));
  const requests = [];
  const original = 'export function add(a, b) {\n  return a - b;\n}\n';
  const fixed = 'export function add(a, b) {\n  return a + b;\n}\n';
  const command = 'node -e "const fs = require(' + "'fs'" +
    '); if (fs.readFileSync(' + "'math.js'" +
    ', ' + "'utf8'" + ').includes(' + "'return a + b;'" +
    ')) console.log(' + "'CHECK PASSED'" + '); else process.exit(1)"';
  const first = toolStream([
    ['before', 'Read', { file_path: 'math.js' }],
    ['fix', 'Edit', { file_path: 'math.js', old_string: 'return a - b;', new_string: 'return a + b;' }],
    ['verify', 'Bash', { command }],
    ['after', 'Read', { file_path: 'math.js' }],
  ]);
  const last = finishStream('Coding task completed and checked.');
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(requests.length === 1 ? first : last);
  });
  const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let child;
  let watchdog;
  try {
    await writeFile(join(workspace, 'math.js'), original);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const args = [
      process.execPath, cli, '--allow-edits', '--max-retries', '0',
      '--cwd', workspace, '--base-url', 'http://127.0.0.1:' + address.port,
      '--model', 'tty-coding-fixture', 'Fix add then run the verification command.',
    ];
    // util-linux script gives the installed CLI a real pseudo-terminal.
    // No programmatic approval bypass: respond only after the actual prompt.
    child = spawn('script', ['-q', '-e', '-c', args.map(shellQuote).join(' '), '/dev/null'], {
      env: { ...process.env, ANTHROPIC_API_KEY: 'tty-fixture-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let approvals = 0;
    let exits = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => {
      output += c;
      if (output.includes('Approve this tool call? [y/N] ') && approvals === 0) {
        approvals += 1;
        child.stdin.write('y\n');
      }
      if (output.includes('you> ') && exits === 0) {
        exits += 1;
        child.stdin.write('/exit\n');
      }
    });
    child.stderr.on('data', c => { stderr += c; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 16000);
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, sig) => resolve([status, sig]));
    });
    assert.equal(signal, null, stderr + output);
    assert.equal(code, 0, stderr + output);
    assert.equal(approvals, 1, output);
    assert.equal(exits, 1, output);
    assert.match(output, /Coding task completed and checked/);
    assert.equal(await readFile(join(workspace, 'math.js'), 'utf8'), fixed);
    assert.equal(requests.length, 2);
    const blocks = requests[1].messages.at(-1).content;
    assert.deepEqual(blocks.map(b => b.tool_use_id), ['before', 'fix', 'verify', 'after']);
    assert.equal(blocks[0].content, original);
    assert.equal(blocks[3].content, fixed);
    assert.equal(blocks[1].is_error, undefined);
    assert.equal(blocks[2].is_error, undefined);
    const bashResult = JSON.parse(blocks[2].content);
    assert.equal(bashResult.exit_code, 0);
    assert.match(bashResult.stdout, /CHECK PASSED/);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
