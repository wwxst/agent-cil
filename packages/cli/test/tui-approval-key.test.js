import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalDecisionFromKey, getPermissionInitialFocus, normalizeFullWidthDigits } from '../src/tui/input.js';

test('pinned PermissionPrompt semantics: bare Enter cannot approve tool use', () => {
  for (const input of ['\r', '\n', '', ' ', 'yes', 'no', 'y\ny', 'n\r\n']) {
    assert.equal(approvalDecisionFromKey(input, { return: true }), null, JSON.stringify(input));
  }
  assert.equal(approvalDecisionFromKey('', { return: true }), null);
  assert.equal(approvalDecisionFromKey('untrusted', { escape: true }), false);
});

test('generic PermissionPrompt Confirmation shortcuts accept only explicit unmodified Y or N', () => {
  for (const input of ['y', 'Y', 'y\r', 'Y\r']) {
    assert.equal(approvalDecisionFromKey(input, { return: input.endsWith('\r') }), true);
  }
  for (const input of ['n', 'N', 'n\r', 'N\r']) {
    assert.equal(approvalDecisionFromKey(input, { return: input.endsWith('\r') }), false);
  }
  for (const key of [{ctrl:true},{meta:true},{shift:true}]) {
    assert.equal(approvalDecisionFromKey('y', key), null);
    assert.equal(approvalDecisionFromKey('n', key), null);
  }
  assert.equal(approvalDecisionFromKey('y\r\r', { return: true }), null);
  assert.equal(approvalDecisionFromKey('\\\r', { return: true }), null);
  assert.equal(approvalDecisionFromKey(undefined, {}), null);
});

test('original CustomSelect numeric input normalizes full-width digits for CJK IMEs', () => {
  assert.equal(normalizeFullWidthDigits('１２３４５６７８９０'), '1234567890');
  assert.equal(normalizeFullWidthDigits('Read ２ files'), 'Read 2 files');
  assert.equal(normalizeFullWidthDigits('no digits'), 'no digits');
});

test('2.1.304 defaultToNo changes initial focus but preserves explicit Y/N decisions', () => {
  assert.equal(getPermissionInitialFocus(true), 'deny');
  assert.equal(getPermissionInitialFocus(false), 'allow');
  assert.equal(getPermissionInitialFocus(), 'allow');
  assert.equal(approvalDecisionFromKey('y', {}), true);
  assert.equal(approvalDecisionFromKey('y\r', { return: true }), true);
  assert.equal(approvalDecisionFromKey('n', {}), false);
  assert.equal(approvalDecisionFromKey('y', {}), true);
});
