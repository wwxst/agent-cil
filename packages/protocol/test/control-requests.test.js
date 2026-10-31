import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ControlRequestError,
  ControlRequestRegistry,
  ControlRequestRegistryClosedError,
  ControlRequestTimeoutError,
  createControlCancelFrame,
} from '../src/control-requests.js';

const success = (requestId, response = {}) => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response },
});

test('correlates responses by request_id rather than arrival order', async () => {
  const registry = new ControlRequestRegistry();
  const first = registry.waitFor('request-a');
  const second = registry.waitFor('request-b');
  assert.equal(registry.accept(success('request-b', { value: 2 })), true);
  assert.equal(registry.accept(success('request-a', { value: 1 })), true);
  assert.deepEqual(await first, { subtype: 'success', request_id: 'request-a', response: { value: 1 } });
  assert.deepEqual(await second, { subtype: 'success', request_id: 'request-b', response: { value: 2 } });
  assert.equal(registry.pendingCount, 0);
});

test('retains a bounded early response until its waiter registers', async () => {
  let now = 100;
  const registry = new ControlRequestRegistry({ maxOrphanResponses: 2, orphanTtlMs: 50, now: () => now });
  registry.accept(success('early', { ready: true }));
  assert.deepEqual(await registry.waitFor('early'), {
    subtype: 'success', request_id: 'early', response: { ready: true },
  });
  registry.accept(success('expired'));
  now = 151;
  const pending = registry.waitFor('expired', { timeoutMs: 10 });
  await assert.rejects(pending, ControlRequestTimeoutError);
});

test('rejects peer error responses with the request id and error code', async () => {
  const registry = new ControlRequestRegistry();
  const pending = registry.waitFor('permission-1');
  registry.accept({ type: 'control_response', response: {
    subtype: 'error', request_id: 'permission-1', error: 'approval failed', error_code: 'DENIED',
  } });
  await assert.rejects(pending, error => {
    assert.ok(error instanceof ControlRequestError);
    assert.equal(error.requestId, 'permission-1');
    assert.equal(error.errorCode, 'DENIED');
    assert.match(error.message, /approval failed/);
    return true;
  });
});

test('aborts only the matching pending request and removes its waiter', async () => {
  const registry = new ControlRequestRegistry();
  const controller = new AbortController();
  const aborted = registry.waitFor('abort-me', { signal: controller.signal });
  const retained = registry.waitFor('keep-me');
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(registry.pendingCount, 1);
  registry.accept(success('keep-me'));
  await retained;
  assert.equal(registry.pendingCount, 0);
});

test('close rejects every waiter and forbids new registrations', async () => {
  const registry = new ControlRequestRegistry();
  const first = registry.waitFor('one');
  const second = registry.waitFor('two');
  registry.close();
  await assert.rejects(first, ControlRequestRegistryClosedError);
  await assert.rejects(second, ControlRequestRegistryClosedError);
  await assert.rejects(registry.waitFor('three'), ControlRequestRegistryClosedError);
  assert.equal(registry.pendingCount, 0);
});

test('emits the documented cancellation frame shape', () => {
  assert.deepEqual(createControlCancelFrame('request-1'), {
    type: 'control_cancel_request', request_id: 'request-1',
  });
  assert.throws(() => createControlCancelFrame(' '), /non-empty string/);
});

test('rejects duplicate waiters and ignores unrelated frames', async () => {
  const registry = new ControlRequestRegistry();
  const pending = registry.waitFor('same-id');
  await assert.rejects(registry.waitFor('same-id'), /already exists/);
  assert.equal(registry.accept({ type: 'assistant', message: {} }), false);
  assert.equal(registry.accept({ type: 'control_response', response: { subtype: 'success' } }), false);
  registry.accept(success('same-id'));
  await pending;
});

test('bounds the early-response cache', async () => {
  const registry = new ControlRequestRegistry({ maxOrphanResponses: 1 });
  registry.accept(success('old'));
  registry.accept(success('new'));
  const oldWaiter = registry.waitFor('old', { timeoutMs: 5 });
  await assert.rejects(oldWaiter, ControlRequestTimeoutError);
  assert.deepEqual(await registry.waitFor('new'), {
    subtype: 'success', request_id: 'new', response: {},
  });
});
