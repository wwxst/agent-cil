import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { runCli } from '../src/main.js';

function io({ isTTY = true } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    stdin: Object.assign(Readable.from([]), { isTTY }),
    stdout: { write: value => { stdout += value; return true; }, get value() { return stdout; } },
    stderr: { write: value => { stderr += value; return true; }, get value() { return stderr; } },
  };
}

function fakeModel(answer = 'hello from fake model') {
  return {
    async *stream() {
      yield { type: 'text_delta', text: answer };
      yield { type: 'message_end', stopReason: 'end_turn' };
    },
  };
}

test('help and version do not construct a model', async () => {
  const streams = io();
  const modelFactory = async () => { throw new Error('must not initialize model'); };
  assert.equal(await runCli(['--help'], { ...streams, modelFactory }), 0);
  assert.match(streams.stdout.value, /Usage:/);
  const version = io();
  assert.equal(await runCli(['--version'], { ...version, modelFactory }), 0);
  assert.match(version.stdout.value, /^agent-cil 0\.1\.0\n$/);
});

test('requires explicit one-shot mode instead of pretending interactive mode exists', async () => {
  const streams = io();
  assert.equal(await runCli([], streams), 2);
  assert.match(streams.stderr.value, /interactive mode is not implemented/);
});

test('streams text from a positional prompt and passes model options', async () => {
  const streams = io();
  let modelOptions;
  const code = await runCli([
    '--print', '--model', 'model-test', '--max-turns', '2',
    '--system-prompt', 'system test', 'say', 'hello',
  ], {
    ...streams,
    env: {},
    modelFactory: async options => { modelOptions = options; return fakeModel('Hello CLI'); },
  });
  assert.equal(code, 0);
  assert.equal(streams.stdout.value, 'Hello CLI\n');
  assert.equal(modelOptions.model, 'model-test');
  assert.equal(modelOptions.systemPrompt, 'system test');
});

test('reads a piped prompt and emits one JSON result', async () => {
  const streams = io({ isTTY: false });
  streams.stdin = Object.assign(Readable.from([Buffer.from('question from stdin')]), { isTTY: false });
  const code = await runCli(['--print', '--output-format=json'], {
    ...streams,
    env: { AGENT_CIL_MODEL: 'env-model' },
    modelFactory: async options => {
      assert.equal(options.model, 'env-model');
      return fakeModel('JSON answer');
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(streams.stdout.value), {
    ok: true,
    text: 'JSON answer',
    stopReason: 'end_turn',
    turns: 1,
  });
});

test('reports missing API credentials as a non-zero runtime error', async () => {
  const streams = io({ isTTY: false });
  const code = await runCli(['--print', 'hello'], { ...streams, env: {} });
  assert.equal(code, 1);
  assert.match(streams.stderr.value, /ANTHROPIC_API_KEY is required/);
});

test('returns structured JSON errors for model failures', async () => {
  const streams = io();
  const code = await runCli(['--print', '--output-format', 'json', 'hello'], {
    ...streams,
    modelFactory: async () => ({
      async *stream() { throw new Error('simulated model failure'); },
    }),
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(streams.stdout.value), {
    ok: false,
    error: { name: 'Error', message: 'simulated model failure' },
  });
});
