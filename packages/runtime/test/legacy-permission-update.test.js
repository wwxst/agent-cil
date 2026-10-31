import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  escapeRuleContent,
  extractRules,
  hasRules,
  permissionRuleValueToString,
  supportsPersistence,
} from '../src/legacy-permissions/permission-update.js';

function emptyContext() {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  };
}

test('ported 2.1.88 permission rule serialization preserves escaped parentheses and backslashes', () => {
  assert.equal(escapeRuleContent('print(1) \\z'), 'print\\(1\\) \\\\z');
  assert.equal(permissionRuleValueToString({ toolName: 'Bash' }), 'Bash');
  assert.equal(permissionRuleValueToString({
    toolName: 'Bash', ruleContent: 'python -c "print(1)"',
  }), 'Bash(python -c "print\\(1\\)")');
  assert.equal(hasRules(undefined), false);
  assert.equal(hasRules([{ type: 'setMode', mode: 'plan' }]), false);
  assert.deepEqual(extractRules([
    { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read' }] },
    { type: 'replaceRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] },
  ]), [{ toolName: 'Read' }]);
});

test('ported 2.1.88 permission context applies allow, deny, ask updates without mutation', () => {
  const original = emptyContext();
  const operations = [
    { type: 'addRules', destination: 'cliArg', behavior: 'allow', rules: [
      { toolName: 'Read' }, { toolName: 'Bash', ruleContent: 'echo(hi)' },
    ] },
    { type: 'addRules', destination: 'session', behavior: 'ask', rules: [{ toolName: 'Bash' }] },
    { type: 'addRules', destination: 'cliArg', behavior: 'deny', rules: [{ toolName: 'Write' }] },
    { type: 'setMode', destination: 'cliArg', mode: 'acceptEdits' },
    { type: 'addDirectories', destination: 'session', directories: ['/workspace/more'] },
  ];
  const changed = applyPermissionUpdates(original, operations);
  assert.deepEqual(changed.alwaysAllowRules.cliArg, ['Read', 'Bash(echo\\(hi\\))']);
  assert.deepEqual(changed.alwaysAskRules.session, ['Bash']);
  assert.deepEqual(changed.alwaysDenyRules.cliArg, ['Write']);
  assert.equal(changed.mode, 'acceptEdits');
  assert.equal(changed.additionalWorkingDirectories.get('/workspace/more').source, 'session');
  assert.equal(original.mode, 'default');
  assert.equal(original.additionalWorkingDirectories.size, 0);
  assert.deepEqual(original.alwaysAllowRules, {});

  const narrowed = applyPermissionUpdates(changed, [
    { type: 'removeRules', destination: 'cliArg', behavior: 'allow', rules: [{ toolName: 'Read' }] },
    { type: 'replaceRules', destination: 'cliArg', behavior: 'deny', rules: [{ toolName: 'Edit' }] },
    { type: 'removeDirectories', destination: 'session', directories: ['/workspace/more'] },
  ]);
  assert.deepEqual(narrowed.alwaysAllowRules.cliArg, ['Bash(echo\\(hi\\))']);
  assert.deepEqual(narrowed.alwaysDenyRules.cliArg, ['Edit']);
  assert.equal(narrowed.additionalWorkingDirectories.size, 0);
  assert.equal(changed.additionalWorkingDirectories.size, 1);
  assert.strictEqual(applyPermissionUpdate(narrowed, { type: 'unknown' }), narrowed);
});

test('ported 2.1.88 settings destination classifier has no I/O side effects', () => {
  assert.equal(supportsPersistence('localSettings'), true);
  assert.equal(supportsPersistence('userSettings'), true);
  assert.equal(supportsPersistence('projectSettings'), true);
  assert.equal(supportsPersistence('session'), false);
  assert.equal(supportsPersistence('cliArg'), false);
});
