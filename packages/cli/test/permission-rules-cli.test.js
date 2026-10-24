import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createCliPermissionContext, createCliPermissionPolicy } from '../src/index.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, props = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...props }) + '\n\n';
function toolStream(id, input) {
  return frame('message_start', { message: { usage: { input_tokens: 30 } } }) +
    frame('content_block_start', { index: 0,
      content_block: { type: 'tool_use', id, name: 'Write', input: {} } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 14 } }) +
    frame('message_stop');
}
function answerStream() {
  return frame('message_start', { message: { usage: { input_tokens: 30 } } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Permission rule checked.' } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }) +
    frame('message_stop');
}
test('original permissions reject unsupported content-specific rules at CLI boundary', () => {
  const accepted = parseArgs(['--allowedTools', 'Write', '--disallowedTools=Read', '--askTools', 'Bash', '-p', 'hello']);
  assert.deepEqual(accepted.permissionRules, {
    allow: [{ toolName: 'Write' }],
    deny: [{ toolName: 'Read' }],
    ask: [{ toolName: 'Bash' }],
  });
  assert.throws(() => parseArgs(['--allowedTools', 'Bash(git push:*)']), /Content-specific/);
  assert.throws(() => parseArgs(['--allowedTools', 'mcp__server__Read']), /MCP rules/);
  assert.throws(() => parseArgs(['--allowedTools', 'Task']), /built-in/);
});

test('original CLI rule precedence is deny > ask > allow even with acceptEdits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cil-rule-policy-'));
  try {
    const ctx = createCliPermissionContext({
      allowEdits: true,
      permissionRules: {
        allow: [{ toolName: 'Write' }],
        ask: [{ toolName: 'Write' }],
        deny: [{ toolName: 'Write' }],
      },
    });
    const policy = createCliPermissionPolicy({ workspace: root, permissionContext: ctx });
    const decision = await policy({ name: 'Write', input: { file_path: 'file.txt', content: 'test' } });
    assert.equal(decision.behavior, 'deny');
    const outside = await policy({ name: 'Write', input: { file_path: '../outside.txt', content: 'x' } });
    assert.equal(outside.behavior, 'deny');
    assert.match(outside.reason, /not authorized/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real installed CLI honors original allow/deny/ask rules without bypassing path safety', {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cil-original-rules-'));
  async function scenario(extra, expected, inputPath = 'result.txt') {
    const received = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(received.length === 1
        ? toolStream('write-' + expected, { file_path: inputPath, content: expected })
        : answerStream());
    });
    let child, watchdog;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      child = spawn(process.execPath, [
        cli, '--print', '--provider', 'deepseek',
        '--cwd', root, '--max-turns', '3', '--max-retries', '0',
        '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
        ...extra, 'Test permission priority.',
      ], { env: { ...process.env, DEEPSEEK_API_KEY: 'local-only' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [], stderr = [];
      child.stdout.on('data', value => stdout.push(value));
      child.stderr.on('data', value => stderr.push(value));
      watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
      const [code, signal] = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, sig) => resolve([status, sig]));
      });
      assert.equal(signal, null, Buffer.concat(stderr).toString('utf8'));
      assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
      assert.match(Buffer.concat(stdout).toString('utf8'), /Permission rule checked/);
      assert.equal(received.length, 2);
      const result = received[1].messages.at(-1).content[0];
      assert.equal(result.tool_use_id, 'write-' + expected);
      return result;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
      server.closeAllConnections?.();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
  try {
    const allow = await scenario(['--allowedTools', 'Write'], 'allow');
    assert.equal(allow.is_error, undefined);
    assert.equal((await readFile(join(root, 'result.txt'), 'utf8')), 'allow');
    const deny = await scenario(['--allow-edits', '--disallowedTools', 'Write'], 'deny');
    assert.equal(deny.is_error, true);
    assert.equal((await readFile(join(root, 'result.txt'), 'utf8')), 'allow');
    const ask = await scenario(['--allowedTools', 'Write', '--askTools', 'Write'], 'ask');
    assert.equal(ask.is_error, true, 'ask rule prevents headless automatic write');
    const unsafe = await scenario(['--allowedTools', 'Write'], 'unsafe', '../escape.txt');
    assert.equal(unsafe.is_error, true, 'allow rule cannot override workspace confinement');
    await assert.rejects(stat(join(root, '..', 'escape.txt')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
