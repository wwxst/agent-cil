import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPermissionUpdates } from '../src/legacy-permissions/permission-update.js';
import {
  unescapeRuleContent,
  permissionRuleValueFromString,
  getAllowRules,
  getAskRules,
  getDenyRules,
  toolAlwaysAllowedRule,
  getAskRuleForTool,
  getDenyRuleForTool,
  checkWholeToolPermissionRules,
} from '../src/legacy-permissions/permission-rules.js';

const empty = () => ({
  mode: 'default',
  alwaysAllowRules: {},
  alwaysDenyRules: {},
  alwaysAskRules: {},
  additionalWorkingDirectories: new Map(),
});

test('2.1.88 parser parity: escaped parentheses, empty wildcard and malformed input', () => {
  assert.equal(unescapeRuleContent('print\\(1\\) \\\\test'), 'print(1) \\test');
  assert.deepEqual(permissionRuleValueFromString('Read'), { toolName: 'Read' });
  assert.deepEqual(permissionRuleValueFromString('Bash(npm install)'), {
    toolName: 'Bash', ruleContent: 'npm install',
  });
  assert.deepEqual(permissionRuleValueFromString('Bash(python -c "print\\(1\\)")'), {
    toolName: 'Bash', ruleContent: 'python -c "print(1)"',
  });
  assert.deepEqual(permissionRuleValueFromString('Write(*)'), { toolName: 'Write' });
  assert.deepEqual(permissionRuleValueFromString('Write()'), { toolName: 'Write' });
  assert.deepEqual(permissionRuleValueFromString('Bash(incomplete'), {
    toolName: 'Bash(incomplete',
  });
  assert.deepEqual(permissionRuleValueFromString('(content)'), { toolName: '(content)' });
  assert.deepEqual(permissionRuleValueFromString('Bash(foo)extra'), {
    toolName: 'Bash(foo)extra',
  });
});

test('ported rule lists preserve source and precedence: deny > ask > allow', () => {
  const context = applyPermissionUpdates(empty(), [
    { type: 'addRules', destination: 'userSettings', behavior: 'allow',
      rules: [{ toolName: 'Write' }, { toolName: 'Bash', ruleContent: 'npm publish' }] },
    { type: 'addRules', destination: 'projectSettings', behavior: 'ask',
      rules: [{ toolName: 'Write' }] },
    { type: 'addRules', destination: 'session', behavior: 'deny',
      rules: [{ toolName: 'Write' }] },
  ]);
  assert.equal(getAllowRules(context).length, 2);
  assert.equal(getAskRules(context)[0].source, 'projectSettings');
  assert.equal(getDenyRules(context)[0].ruleValue.toolName, 'Write');
  assert.equal(toolAlwaysAllowedRule(context, { name: 'Write' }).source, 'userSettings');
  assert.equal(getAskRuleForTool(context, { name: 'Write' }).source, 'projectSettings');
  assert.equal(getDenyRuleForTool(context, { name: 'Write' }).source, 'session');

  const decision = checkWholeToolPermissionRules(context, { name: 'Write' });
  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.decisionReason.rule.source, 'session');
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Bash' }), null,
    'content-specific rule must not become whole-tool permission');
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Read' }), null);
});

test('ported rule engine handles ask before allow and updates take effect immutably', () => {
  const original = empty();
  const context = applyPermissionUpdates(original, [
    { type: 'addRules', destination: 'session', behavior: 'allow',
      rules: [{ toolName: 'Edit' }] },
    { type: 'addRules', destination: 'session', behavior: 'ask',
      rules: [{ toolName: 'Edit' }] },
  ]);
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Edit' }).behavior, 'ask');
  assert.equal(checkWholeToolPermissionRules(original, { name: 'Edit' }), null);

  const updated = applyPermissionUpdates(context, [
    { type: 'removeRules', destination: 'session', behavior: 'ask',
      rules: [{ toolName: 'Edit' }] },
  ]);
  assert.equal(checkWholeToolPermissionRules(updated, { name: 'Edit' }).behavior, 'allow');
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Edit' }).behavior, 'ask');
});
