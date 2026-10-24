import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHookResults } from '../src/legacy-tools/pretooluse-hook-aggregation.js';

async function collect(outcomes) {
  const result = [];
  for await (const item of aggregateHookResults(
    outcomes.map(result => Promise.resolve(result)),
  )) result.push(item);
  return result;
}
test('original executeHooks combination: deny wins independent of hook ordering', async () => {
  for (const sequence of [
    [{ permissionBehavior: 'deny' }, { permissionBehavior: 'allow' }],
    [{ permissionBehavior: 'allow' }, { permissionBehavior: 'deny' }],
  ]) {
    const events = await collect(sequence);
    assert.equal(events.at(-1).permissionBehavior, 'deny');
  }
});
test('original executeHooks combination: ask wins over allow in either order', async () => {
  for (const sequence of [
    [{ permissionBehavior: 'ask' }, { permissionBehavior: 'allow' }],
    [{ permissionBehavior: 'allow' }, { permissionBehavior: 'ask' }],
  ]) {
    const events = await collect(sequence);
    assert.equal(events.at(-1).permissionBehavior, 'ask');
  }
});
test('exit-status-2 blocking result can never be undone by later JSON allow', async () => {
  const events = await collect([
    { blockingError: { blockingError: 'blocked by team policy' } },
    { permissionBehavior: 'allow', updatedInput: { file_path: 'changed.txt' } },
  ]);
  assert.ok(events.some(event => event.blockingError));
  assert.equal(events.at(-1).permissionBehavior, 'deny');
});
test('original passthrough input rewrite emits update without granting approval', async () => {
  const events = await collect([
    { updatedInput: { file_path: 'safe.txt' } },
  ]);
  assert.deepEqual(events, [{ updatedInput: { file_path: 'safe.txt' } }]);
});
test('denied hook never forwards updatedInput into original permission resolver', async () => {
  const events = await collect([
    { permissionBehavior: 'allow', updatedInput: { file_path: 'allowed.txt' } },
    { permissionBehavior: 'deny', updatedInput: { file_path: 'not-authorized.txt' } },
  ]);
  const decision = events.at(-1);
  assert.equal(decision.permissionBehavior, 'deny');
  assert.equal(decision.updatedInput, undefined);
});
test('hook result aggregator ignores invalid decision output and permits no allow', async () => {
  const events = await collect([
    { message: { type: 'attachment', attachment: { type: 'hook_non_blocking_error' } } },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].permissionBehavior, undefined);
});
