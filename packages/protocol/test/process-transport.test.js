import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ProcessTransport } from '../src/process-transport.js';

class FakeChild extends EventEmitter {
  constructor({ exitOnStdinEnd = true } = {}) {
    super();
    this.pid = 4242;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killSignals = [];
    this.exitOnStdinEnd = exitOnStdinEnd;
    if (exitOnStdinEnd) this.stdin.on('finish', () => setImmediate(() => this.exit(0, null)));
  }

  kill(signal) {
    this.killSignals.push(signal);
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  exit(code, signal) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

function createHarness(options = {}) {
  const child = new FakeChild(options);
  const calls = [];
  const transport = new ProcessTransport({
    command: 'fake-agent',
    args: ['--output-format', 'stream-json'],
    cwd: '/workspace',
    env: { TEST_MODE: '1' },
    killGracePeriodMs: 10,
    stderrTailBytes: 8,
    spawnImpl: (command, args, spawnOptions) => {
      calls.push({ command, args, spawnOptions });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  return { child, calls, transport };
}

test('spawns with piped stdio and exposes JSONL frames', async () => {
  const { child, calls, transport } = createHarness();
  const framePromise = once(transport, 'frame');
  await transport.start();
  assert.equal(transport.state, 'running');
  assert.equal(transport.pid, 4242);
  assert.equal(calls[0].command, 'fake-agent');
  assert.deepEqual(calls[0].args, ['--output-format', 'stream-json']);
  assert.deepEqual(calls[0].spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[0].spawnOptions.cwd, '/workspace');

  child.stdout.write('{"type":"assistant","text":"hello"}\n');
  assert.deepEqual((await framePromise)[0], { type: 'assistant', text: 'hello' });
  await transport.close();
  assert.equal(transport.state, 'closed');
  assert.equal(transport.exitResult.code, 0);
});

test('writes JSONL frames and ends stdin explicitly', async () => {
  const { child, transport } = createHarness();
  const input = [];
  child.stdin.on('data', chunk => input.push(chunk));
  await transport.start();
  await transport.writeFrame({ type: 'user', text: 'hello' });
  assert.equal(Buffer.concat(input).toString('utf8'), '{"type":"user","text":"hello"}\n');
  await transport.endInput();
  await once(transport, 'exit');
  assert.equal(transport.state, 'closed');
});

test('captures a bounded stderr tail without logging it automatically', async () => {
  const { child, transport } = createHarness();
  const chunks = [];
  transport.on('stderr', chunk => chunks.push(chunk));
  await transport.start();
  child.stderr.write('123456');
  child.stderr.write('7890');
  assert.equal(transport.stderrTail, '34567890');
  assert.equal(chunks.length, 2);
  await transport.close();
});

test('rejects writes before start and after close', async () => {
  const { transport } = createHarness();
  await assert.rejects(transport.writeFrame({ type: 'user' }), /state new/);
  await transport.close();
  await assert.rejects(transport.writeFrame({ type: 'user' }), /state closed/);
});

test('terminates a child that ignores stdin close after the grace period', async () => {
  const { child, transport } = createHarness({ exitOnStdinEnd: false });
  await transport.start();
  const exitPromise = transport.close({ gracePeriodMs: 5 });
  const result = await exitPromise;
  assert.ok(child.killSignals.includes('SIGTERM'));
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(transport.state, 'closed');
});

test('reports startup errors and settles the close promise', async () => {
  const child = new FakeChild();
  const transport = new ProcessTransport({
    command: 'missing-agent',
    spawnImpl: () => {
      setImmediate(() => {
        child.emit('error', new Error('spawn failed'));
        child.exit(null, null);
      });
      return child;
    },
  });
  const errorPromise = once(transport, 'transportError');
  await assert.rejects(transport.start(), /spawn failed/);
  assert.match((await errorPromise)[0].message, /spawn failed/);
  assert.equal(transport.state, 'closed');
  assert.match(transport.exitResult.error.message, /spawn failed/);
});
