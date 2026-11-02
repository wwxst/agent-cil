import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTuiInterruptHandler } from '../src/tui/interrupt.js';

test('idle TUI exits only on a second Ctrl+C within the original 800ms window', () => {
  let time = 1000;
  let messages = 0;
  let exits = 0;
  const interrupt = createTuiInterruptHandler({
    getActiveController: () => undefined,
    onCancelMessage: () => { messages++; },
    onExit: () => { exits++; },
    now: () => time,
  });

  assert.equal(interrupt(), 'armed');
  assert.equal(messages, 1);
  time += 799;
  assert.equal(interrupt(), 'exit');
  assert.equal(exits, 1);
  assert.equal(messages, 1);
});

test('a second idle Ctrl+C after 800ms rearms instead of exiting', () => {
  let time = 1000;
  let messages = 0;
  let exits = 0;
  const interrupt = createTuiInterruptHandler({
    getActiveController: () => undefined,
    onCancelMessage: () => { messages++; },
    onExit: () => { exits++; },
    now: () => time,
  });

  assert.equal(interrupt(), 'armed');
  time += 801;
  assert.equal(interrupt(), 'armed');
  assert.equal(messages, 2);
  assert.equal(exits, 0);
});

test('Ctrl+C cancels active work and never releases its owner before cleanup', () => {
  let time = 1000;
  let activeController = new AbortController();
  let messages = 0;
  let exits = 0;
  const interrupt = createTuiInterruptHandler({
    getActiveController: () => activeController,
    onCancelMessage: () => { messages++; },
    onExit: () => { exits++; },
    now: () => time,
  });

  assert.equal(interrupt(), 'cancelled');
  assert.equal(activeController.signal.aborted, true);
  assert.equal(exits, 0);

  time += 100;
  assert.equal(interrupt(), 'waiting-for-cleanup');
  assert.equal(exits, 0);
  assert.equal(messages, 1);

  activeController = undefined;
  time += 100;
  assert.equal(interrupt(), 'exit');
  assert.equal(exits, 1);
});

test('an active cancellation resets any previous idle exit window', () => {
  let time = 1000;
  let activeController;
  let messages = 0;
  let exits = 0;
  const interrupt = createTuiInterruptHandler({
    getActiveController: () => activeController,
    onCancelMessage: () => { messages++; },
    onExit: () => { exits++; },
    now: () => time,
  });

  assert.equal(interrupt(), 'armed');
  activeController = new AbortController();
  assert.equal(interrupt(), 'cancelled');
  activeController = undefined;
  time += 100;
  assert.equal(interrupt(), 'armed');
  assert.equal(exits, 0);
  assert.equal(messages, 2);
});
