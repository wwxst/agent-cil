import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeRuleContent, unescapeRuleContent,
  permissionRuleValueFromString, permissionRuleValueToString,
  normalizeLegacyToolName, getLegacyToolNames,
} from '../src/legacy-permissions/permission-rule-parser.js';
import {
  mcpInfoFromString, getToolNameForPermissionCheck,
} from '../src/legacy-permissions/mcp-string-utils.js';
import {
  getDenyRuleForTool, getAskRuleForTool, toolAlwaysAllowedRule,
  checkWholeToolPermissionRules,
} from '../src/legacy-permissions/permission-rules.js';

test('original 2.1.88 parser roundtrips escaped parentheses and backslashes', () => {
  const value = { toolName: 'Bash', ruleContent: 'python -c "print(1)" \\tmp\\test' };
  const encoded = permissionRuleValueToString(value);
  assert.deepEqual(permissionRuleValueFromString(encoded), value);
  assert.equal(unescapeRuleContent(escapeRuleContent(value.ruleContent)), value.ruleContent);
  assert.deepEqual(permissionRuleValueFromString('Bash(*)'), { toolName: 'Bash' });
  assert.deepEqual(permissionRuleValueFromString('Bash()'), { toolName: 'Bash' });
  assert.deepEqual(permissionRuleValueFromString('(foo)'), { toolName: '(foo)' });
  assert.deepEqual(permissionRuleValueFromString('Bash(foo)trailing'), { toolName: 'Bash(foo)trailing' });
});

test('original permission parser retains legacy tool aliases without granting unavailable tools', () => {
  assert.equal(normalizeLegacyToolName('Task'), 'Agent');
  assert.equal(normalizeLegacyToolName('KillShell'), 'TaskStop');
  assert.deepEqual(permissionRuleValueFromString('Task(Explore)'), {
    toolName: 'Agent', ruleContent: 'Explore',
  });
  assert.ok(getLegacyToolNames('TaskStop').includes('KillShell'));
});

test('original MCP service-wide rules match full MCP identities but not builtins or other servers', () => {
  const context = {
    alwaysAllowRules: { cliArg: ['Read', 'mcp__alpha__*'] },
    alwaysDenyRules: { session: ['mcp__beta'] },
    alwaysAskRules: {},
  };
  const alpha = { name: 'Read', mcpInfo: { serverName: 'alpha', toolName: 'Read' } };
  const beta = { name: 'fetch', mcpInfo: { serverName: 'beta', toolName: 'fetch' } };
  assert.equal(getToolNameForPermissionCheck(alpha), 'mcp__alpha__Read');
  assert.deepEqual(mcpInfoFromString('mcp__alpha__complex__name'), {
    serverName: 'alpha', toolName: 'complex__name',
  });
  assert.equal(toolAlwaysAllowedRule(context, alpha)?.ruleValue.toolName, 'mcp__alpha__*');
  assert.equal(getDenyRuleForTool(context, beta)?.ruleValue.toolName, 'mcp__beta');
  assert.equal(toolAlwaysAllowedRule(context, { name: 'Read' })?.ruleValue.toolName, 'Read');
  assert.equal(toolAlwaysAllowedRule(context, { name: 'Write', mcpInfo: { serverName: 'beta', toolName: 'Write' } }), null);
});

test('original deny then ask then allow priority, and content-only rules never become whole-tool grants', () => {
  const context = {
    alwaysAllowRules: { cliArg: ['Bash', 'Write'] },
    alwaysAskRules: { userSettings: ['Bash'] },
    alwaysDenyRules: { projectSettings: ['Bash'] },
  };
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Bash' }).behavior, 'deny');
  context.alwaysDenyRules = {};
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Bash' }).behavior, 'ask');
  context.alwaysAskRules = {};
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Bash' }).behavior, 'allow');
  context.alwaysAllowRules = { cliArg: ['Bash(prefix:*)'] };
  assert.equal(checkWholeToolPermissionRules(context, { name: 'Bash' }), null);
  assert.equal(getAskRuleForTool(context, { name: 'Bash' }), null);
});
