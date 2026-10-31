import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCoalescedEnterText, getPermissionInitialFocus } from '../src/tui/input.js';

test('original Select leaves permission decisions to the focused option and Enter', () => {
  assert.equal(getCoalescedEnterText('y\\r'), 'y');
  assert.equal(getCoalescedEnterText('n\\r'), 'n');
  assert.equal(getCoalescedEnterText('\\r'), null);
  assert.equal(getCoalescedEnterText('hello\\r'), 'hello');
  assert.equal(getCoalescedEnterText('hello'), null);
});

test('2.1.304 defaultToNo starts on Deny; ordinary asks keep original Allow-first focus', () => {
  assert.equal(getPermissionInitialFocus(true), 'deny');
  assert.equal(getPermissionInitialFocus(false), 'allow');
  assert.equal(getPermissionInitialFocus(), 'allow');
});
