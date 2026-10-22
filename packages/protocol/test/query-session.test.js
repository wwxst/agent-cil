import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { QueryProtocolSession, NO_CONTROL_RESPONSE } from '../src/query-session.js';

class FakeTransport extends EventEmitter {
  constructor() {
    super();
    this.state = 'new';
    this.frames = [];
    this.exitResult = undefined;
  }

  async start() {
    this.state = 'running';
    return this;
  }

  async writeFrame(frame) {
    if (this.state !== 'running') throw new Error(`fake transport is ${this.state}`);
    this.frames.push(frame);
    this.emit('written', frame);
  }

  async close() {
    if (this.state === 'closed') return this.exitResult;
    this.state = 'closed';
    this.exitResult = { code: 0, signal: null };
    this.emit('exit', this.exitResult);
    return this.exitResult;
  }

  receive(frame) {
    this.emit('frame', frame);
  }
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition was not reached before the test deadline');
}

function createSession() {
  const transport = new FakeTransport();
  let id = 0;
  const session = new QueryProtocolSession({
    transport,
    requestIdFactory: () => `request-${++id}`,
    defaultControlTimeoutMs: 1_000,
  });
  return { session, transport };
}

test('requires initialize before user input and writes initialize first', async () => {
  const { session, transport } = createSession();
  await session.start();
  await assert.rejects(session.sendInput({ type: 'user' }), /Initialize must be called/);

  const initialized = session.initialize({ systemPrompt: 'system instructions' });
  await session.sendInput({ type: 'user', message: { role: 'user', content: 'hello' } });
  assert.equal(transport.frames[0].type, 'control_request');
  assert.equal(transport.frames[0].request.subtype, 'initialize');
  assert.equal(transport.frames[1].type, 'user');
  assert.equal(session.initializeWritten, true);

  transport.receive({ type: 'control_response', response: {
    subtype: 'success', request_id: 'request-1', response: { protocolVersion: 1 },
  } });
  assert.deepEqual(await initialized, {
    subtype: 'success', request_id: 'request-1', response: { protocolVersion: 1 },
  });
  await session.close();
});

test('correlates outbound control requests by request id', async () => {
  const { session, transport } = createSession();
  await session.start();
  const pending = session.requestControl('interrupt', { reason: 'user' });
  await waitUntil(() => transport.frames.length === 1);
  assert.deepEqual(transport.frames[0], {
    type: 'control_request', request_id: 'request-1', request: { reason: 'user', subtype: 'interrupt' },
  });
  transport.receive({ type: 'control_response', response: {
    subtype: 'success', request_id: 'request-1', response: { interrupted: true },
  } });
  assert.deepEqual(await pending, {
    subtype: 'success', request_id: 'request-1', response: { interrupted: true },
  });
  await session.close();
});

test('dispatches host control requests and writes a correlated success response', async () => {
  const { session, transport } = createSession();
  await session.start();
  session.registerControlHandler('can_use_tool', async (request, context) => ({
    behavior: 'allow', toolUseID: request.tool_use_id, requestId: context.requestId,
  }));

  transport.receive({ type: 'control_request', request_id: 'cli-request-1', request: {
    subtype: 'can_use_tool', tool_name: 'read_file', tool_use_id: 'tool-9', input: { path: 'README.md' },
  } });
  await waitUntil(() => transport.frames.length === 1);
  assert.deepEqual(transport.frames[0], {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'cli-request-1', response: {
      behavior: 'allow', toolUseID: 'tool-9', requestId: 'cli-request-1',
    } },
  });
  assert.equal(session.pendingControlHandlerCount, 0);
  await session.close();
});

test('cancels a pending host callback without replying after cancellation', async () => {
  const { session, transport } = createSession();
  await session.start();
  let observedSignal;
  session.registerControlHandler('slow_callback', (_request, { signal }) => new Promise(resolve => {
    observedSignal = signal;
    signal.addEventListener('abort', () => resolve({ late: true }), { once: true });
  }));

  transport.receive({ type: 'control_request', request_id: 'cli-request-2', request: { subtype: 'slow_callback' } });
  await waitUntil(() => session.pendingControlHandlerCount === 1);
  transport.receive({ type: 'control_cancel_request', request_id: 'cli-request-2' });
  await waitUntil(() => observedSignal?.aborted === true && session.pendingControlHandlerCount === 0);
  assert.equal(transport.frames.length, 0);
  await session.close();
});

test('returns an explicit error for unhandled control subtypes', async () => {
  const { session, transport } = createSession();
  await session.start();
  transport.receive({ type: 'control_request', request_id: 'cli-request-3', request: { subtype: 'not_registered' } });
  await waitUntil(() => transport.frames.length === 1);
  assert.equal(transport.frames[0].response.subtype, 'error');
  assert.equal(transport.frames[0].response.request_id, 'cli-request-3');
  assert.equal(transport.frames[0].response.error_code, 'UNHANDLED_CONTROL_REQUEST');
  await session.close();
});

test('cancels outbound requests when the session closes', async () => {
  const { session } = createSession();
  await session.start();
  const pending = session.requestControl('interrupt', {}, { timeoutMs: 5_000 });
  const rejected = assert.rejects(pending, /closed|exited/);
  await session.close();
  await rejected;
  assert.equal(session.state, 'closed');
});

test('supports host requests intentionally delegated to another execution host', async () => {
  const { session, transport } = createSession();
  await session.start();
  session.registerControlHandler('delegate', async () => NO_CONTROL_RESPONSE);
  transport.receive({ type: 'control_request', request_id: 'cli-request-4', request: { subtype: 'delegate' } });
  await waitUntil(() => session.pendingControlHandlerCount === 0);
  assert.equal(transport.frames.length, 0);
  await session.close();
});

test('sends a control-cancel frame when an outbound request is aborted', async () => {
  const { session, transport } = createSession();
  await session.start();
  const controller = new AbortController();
  const pending = session.requestControl('slow_operation', {}, { signal: controller.signal, timeoutMs: 5_000 });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await waitUntil(() => transport.frames.length === 1);
  controller.abort();
  await rejected;
  await waitUntil(() => transport.frames.length === 2);
  assert.deepEqual(transport.frames[1], { type: 'control_cancel_request', request_id: 'request-1' });
  await session.close();
});
