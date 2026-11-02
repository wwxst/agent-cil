import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const verificationScript = fileURLToPath(
  new URL('../../../scripts/verify-live-tui.mjs', import.meta.url),
);
const cliEntry = fileURLToPath(new URL('../src/index.js', import.meta.url));

const sse = (type, fields = {}) =>
  'event: ' + type + '\\ndata: ' + JSON.stringify({ type, ...fields }) + '\\n\\n';

function textReply(text) {
  return [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', {
      index: 0, content_block: { type: 'text', text: '' },
    }),
    sse('content_block_delta', {
      index: 0, delta: { type: 'text_delta', text },
    }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' } }),
    sse('message_stop'),
  ].join('');
}

function toolReply(id, name, input) {
  return [
    sse('message_start', { message: { usage: { input_tokens: 2 } } }),
    sse('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    }),
    sse('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sse('message_stop'),
  ].join('');
}

// Run the exact credentialed interactive acceptance script against a local
// Anthropic-protocol fixture. This validates the node-pty/ConPTY harness,
// two live Ink turns, Read -> Edit -> Read, prompt re-entry, config persistence,
// and cleanup without requiring or exposing a real provider credential.
test('live Ink TUI acceptance harness completes two turns through native ConPTY', {
  timeout: 90000,
  skip: process.platform !== 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-live-tui-fixture-'));
  const requests = [];
  const responses = [
    toolReply('live-read-before', 'Read', { file_path: 'math.js' }),
    toolReply('live-edit', 'Edit', {
      file_path: 'math.js',
      old_string: 'return a - b;',
      new_string: 'return a + b;',
    }),
    toolReply('live-read-after', 'Read', { file_path: 'math.js' }),
    textReply('LIVE_TUI_FIXED'),
    toolReply('live-read-second', 'Read', { file_path: 'math.js' }),
    textReply('LIVE_TUI_SECOND_TURN:5'),
  ];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.end(responses[requests.length - 1] ?? textReply('unexpected fixture request'));
  });

  let child;
  let watchdog;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    child = spawn(process.execPath, [verificationScript, cliEntry], {
      cwd: workspace,
      env: {
        ...process.env,
        AGENT_CIL_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'local-live-tui-fixture-secret',
        ANTHROPIC_MODEL: 'claude-sonnet-4-5',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + address.port + '/anthropic',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    watchdog = setTimeout(() => child.kill('SIGKILL'), 80000);

    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });

    assert.equal(signal, null, stderr + stdout);
    assert.equal(status, 0, stderr + stdout);
    assert.match(stdout, /PASS: real Ink TUI completed Read -> Edit -> Read/);
    assert.match(stdout, /PASS: second interactive turn completed/);
    assert.match(stdout, /Credentialed live TUI acceptance completed/);
    assert.doesNotMatch(stdout + stderr, /local-live-tui-fixture-secret/);
    assert.equal(requests.length, 6, stderr + stdout);
    assert.ok(requests.every(request => request.body.model === 'claude-sonnet-4-5'));
    assert.ok(requests.every(request => request.headers['x-api-key'] === 'local-live-tui-fixture-secret'));

    const finalFile = await readFile(join(workspace, 'math.js'), 'utf8').catch(() => null);
    // The acceptance script owns and removes its temporary workspace; the
    // test's parent workspace must not be modified by the child CLI.
    assert.equal(finalFile, null);

    const toolResults = requests.flatMap(request =>
      request.body.messages.flatMap(message =>
        message.role === 'user' && Array.isArray(message.content)
          ? message.content.filter(block => block.type === 'tool_result')
          : [],
      ),
    );
    assert.deepEqual(toolResults.map(result => result.tool_use_id), [
      'live-read-before',
      'live-edit',
      'live-read-after',
      'live-read-second',
    ]);
    assert.equal(toolResults[0].content.includes('return a - b;'), true);
    assert.equal(toolResults[1].is_error, undefined);
    assert.equal(toolResults[2].content.includes('return a + b;'), true);
    assert.equal(toolResults[3].content.includes('return a + b;'), true);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
