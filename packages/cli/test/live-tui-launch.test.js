import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const sse = (type, fields = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';

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

// Call the real acceptance script in this test process so node-pty can attach
// to the Windows runner's console. Spawning a nested Node process detaches it
// from that console and makes ConPTY's AttachConsole bootstrap fail in CI.
test('live Ink TUI acceptance harness completes two turns through native ConPTY', {
  timeout: 90000,
  skip: process.platform !== 'win32',
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-live-tui-fixture-'));
  const envKeys = [
    'AGENT_CIL_PROVIDER',
    'AGENT_CIL_TEST_EXECUTABLE',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_BASE_URL',
    'TEMP',
    'TMP',
  ];
  const originalEnv = new Map(envKeys.map(key => [key, process.env[key]]));
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

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    process.env.AGENT_CIL_PROVIDER = 'anthropic';
    process.env.AGENT_CIL_TEST_EXECUTABLE =
      fileURLToPath(new URL('../src/index.js', import.meta.url));
    process.env.ANTHROPIC_API_KEY = 'local-live-tui-fixture-secret';
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    process.env.ANTHROPIC_BASE_URL =
      'http://127.0.0.1:' + address.port + '/anthropic';
    process.env.TEMP = workspace;
    process.env.TMP = workspace;

    const { main } = await import('../../../scripts/verify-live-tui.mjs');
    await main({ turnTimeoutMs: 30000 });

    assert.equal(requests.length, 6);
    assert.ok(requests.every(request => request.body.model === 'claude-sonnet-4-5'));
    assert.ok(requests.every(request =>
      request.headers['x-api-key'] === 'local-live-tui-fixture-secret'));
    const toolResults = requests[5].body.messages.flatMap(message =>
      message.role === 'user' && Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'tool_result')
        : [],
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

    // The script's finally block must remove its nested workspace and config.
    assert.deepEqual(await readdir(workspace), []);
  } finally {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  }
});
