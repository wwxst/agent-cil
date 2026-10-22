import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { QueryRunLifecycle } from '../src/query-lifecycle.js';

function createLifecycle(options = {}) {
  const session = new EventEmitter();
  const lifecycle = new QueryRunLifecycle({ session, ...options });
  return { session, lifecycle };
}

test('ends immediately on result when no bidirectional host callbacks are configured', async () => {
  const { session, lifecycle } = createLifecycle({ hasBidirectionalNeeds: false });
  lifecycle.beginRun();
  const ended = once(lifecycle, 'runEnded');
  session.emit('frame', { type: 'result', subtype: 'success', result: 'done' });
  assert.deepEqual((await ended)[0], {
    reason: 'result', sessionState: undefined, resultReceived: true,
  });
  assert.equal(lifecycle.runEnded, true);
  assert.equal(lifecycle.state, 'ended');
  lifecycle.close();
});

test('waits for idle after result when bidirectional callbacks are configured', async () => {
  const { session, lifecycle } = createLifecycle({
    hasBidirectionalNeeds: true,
    runEndCeilingMs: 200,
  });
  lifecycle.beginRun();
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'running' });
  const waiting = lifecycle.waitForRunEnd();
  session.emit('frame', { type: 'result', result: 'tool approval pending' });
  assert.equal(lifecycle.resultReceived, true);
  assert.equal(lifecycle.runEnded, false);
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lifecycle.runEnded, false, 'requires_action must clear the end ceiling');
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.deepEqual(await waiting, {
    reason: 'idle', sessionState: 'idle', resultReceived: true,
  });
  lifecycle.close();
});

test('uses the end ceiling if result arrives while the session remains active', async () => {
  const { session, lifecycle } = createLifecycle({
    hasBidirectionalNeeds: true,
    runEndCeilingMs: 10,
  });
  lifecycle.beginRun();
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'running' });
  const waiting = lifecycle.waitForRunEnd();
  session.emit('frame', { type: 'result', result: 'done' });
  assert.deepEqual(await waiting, {
    reason: 'ceiling', sessionState: 'running', resultReceived: true,
  });
  lifecycle.close();
});

test('idle received before result is remembered and closes the run after result', async () => {
  const { session, lifecycle } = createLifecycle({ hasBidirectionalNeeds: true });
  lifecycle.beginRun();
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  const waiting = lifecycle.waitForRunEnd();
  session.emit('frame', { type: 'result', result: 'done' });
  assert.deepEqual(await waiting, {
    reason: 'result', sessionState: 'idle', resultReceived: true,
  });
  lifecycle.close();
});

test('reopens a multi-turn run when a new active session state arrives', async () => {
  const { session, lifecycle } = createLifecycle({ hasBidirectionalNeeds: false });
  lifecycle.beginRun();
  session.emit('frame', { type: 'result', result: 'first' });
  assert.equal(lifecycle.runEnded, true);
  const resumed = once(lifecycle, 'runResumed');
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
  assert.deepEqual((await resumed)[0], { state: 'requires_action' });
  assert.equal(lifecycle.runEnded, false);
  const waiting = lifecycle.waitForRunEnd();
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  assert.equal(lifecycle.runEnded, false, 'idle alone does not end a run before a result');
  session.emit('frame', { type: 'result', result: 'second' });
  assert.deepEqual(await waiting, {
    reason: 'result', sessionState: 'idle', resultReceived: true,
  });
  lifecycle.close();
});

test('single-user-turn mode does not reopen after the run ended', async () => {
  const { session, lifecycle } = createLifecycle({ isSingleUserTurn: true });
  lifecycle.beginRun();
  session.emit('frame', { type: 'result', result: 'done' });
  assert.equal(lifecycle.runEnded, true);
  session.emit('frame', { type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
  assert.equal(lifecycle.runEnded, true);
  lifecycle.close();
});

test('waitForRunEnd supports abort and removes the waiter', async () => {
  const { lifecycle } = createLifecycle();
  lifecycle.beginRun();
  const controller = new AbortController();
  const waiting = lifecycle.waitForRunEnd({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const resolved = lifecycle.waitForRunEnd();
  lifecycle.endRun('test');
  assert.deepEqual(await resolved, {
    reason: 'test', sessionState: undefined, resultReceived: false,
  });
  lifecycle.close();
});

test('closing the attached Query session rejects pending run waiters', async () => {
  const { session, lifecycle } = createLifecycle();
  lifecycle.beginRun();
  const waiting = lifecycle.waitForRunEnd();
  const rejected = assert.rejects(waiting, /session closed/);
  session.emit('closed', { error: new Error('session closed') });
  await rejected;
  assert.equal(lifecycle.state, 'closed');
  assert.equal(lifecycle.runEnded, false);
});

test('automatically begins tracking when a result arrives without an explicit beginRun', async () => {
  const { session, lifecycle } = createLifecycle();
  const started = once(lifecycle, 'runStarted');
  session.emit('frame', { type: 'result', result: 'done' });
  await started;
  assert.equal(lifecycle.runEnded, true);
  lifecycle.close();
});
