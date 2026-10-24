/** Legacy CLI 2.1.88 permissions.ts whole-tool rule matcher and source order.
 * Actual parser and MCP name utilities are mechanically ported source files. */
import { permissionRuleValueFromString } from './permission-rule-parser.js';
import { mcpInfoFromString, getToolNameForPermissionCheck } from './mcp-string-utils.js';
export { permissionRuleValueFromString, unescapeRuleContent } from './permission-rule-parser.js';

// Original utils/settings/constants.ts + permissions.ts priority list.
const PERMISSION_RULE_SOURCES = [
  'userSettings', 'projectSettings', 'localSettings', 'flagSettings',
  'policySettings', 'cliArg', 'command', 'session',
];
function getRules(context, ruleKind, behavior) {
  // From 2.1.88 permissions.ts: only the known rule-source categories and
  // their original precedence participate in matching.
  return PERMISSION_RULE_SOURCES.flatMap(source =>
    (context?.[ruleKind]?.[source] || []).map(ruleString => ({
      source, ruleBehavior: behavior,
      ruleValue: permissionRuleValueFromString(ruleString),
    })));
}

export function getAllowRules(context) {
  return getRules(context, 'alwaysAllowRules', 'allow');
}
export function getDenyRules(context) {
  return getRules(context, 'alwaysDenyRules', 'deny');
}
export function getAskRules(context) {
  return getRules(context, 'alwaysAskRules', 'ask');
}

/**
 * Original CLI 2.1.88 permissions.ts:getRuleByContentsForToolName().
 * Content-specific rules are resolved by tool.checkPermissions(), never by
 * whole-tool allow/ask/deny matching. Preserve the original rule ordering.
 */
export function getRuleByContentsForToolName(context, toolName, behavior) {
  const ruleByContents = new Map();
  const rules = behavior === 'allow' ? getAllowRules(context)
    : behavior === 'deny' ? getDenyRules(context)
    : behavior === 'ask' ? getAskRules(context) : [];
  for (const rule of rules) {
    if (rule.ruleValue.toolName === toolName &&
        rule.ruleValue.ruleContent !== undefined &&
        rule.ruleBehavior === behavior) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule);
    }
  }
  return ruleByContents;
}

export function getRuleByContentsForTool(context, tool, behavior) {
  return getRuleByContentsForToolName(
    context, getToolNameForPermissionCheck(tool), behavior,
  );
}

function toolMatchesRule(tool, rule) {
  // Original permissions.ts toolMatchesRule: content-specific rules only
  // participate in the tool's own checkPermissions() method.
  if (rule.ruleValue.ruleContent !== undefined) return false;
  const nameForRuleMatch = getToolNameForPermissionCheck(tool);
  if (rule.ruleValue.toolName === nameForRuleMatch) return true;
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName);
  const toolInfo = mcpInfoFromString(nameForRuleMatch);
  return (
    ruleInfo !== null && toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  );
}

export function toolAlwaysAllowedRule(context, tool) {
  return getAllowRules(context).find(rule => toolMatchesRule(tool, rule)) || null;
}
export function getDenyRuleForTool(context, tool) {
  return getDenyRules(context).find(rule => toolMatchesRule(tool, rule)) || null;
}
export function getAskRuleForTool(context, tool) {
  return getAskRules(context).find(rule => toolMatchesRule(tool, rule)) || null;
}

/**
 * Original checkRuleBasedPermissions/hasPermissionsToUseToolInner precedence,
 * limited to whole-tool rules: deny > ask > allow.
 * Return null when no explicit rule applies.
 *
 * This is only a policy candidate: the CLI's path checks must run first,
 * and the AgentLoop re-checks every permission-rewritten input before execution.
 */
export function checkWholeToolPermissionRules(context, tool) {
  const denyRule = getDenyRuleForTool(context, tool);
  if (denyRule) return {
    behavior: 'deny',
    reason: 'Permission to use ' + tool.name + ' has been denied.',
    decisionReason: { type: 'rule', rule: denyRule },
  };
  const askRule = getAskRuleForTool(context, tool);
  if (askRule) return {
    behavior: 'ask',
    reason: 'Permission to use ' + tool.name + ' requires approval.',
    decisionReason: { type: 'rule', rule: askRule },
  };
  const allowRule = toolAlwaysAllowedRule(context, tool);
  if (allowRule) return {
    behavior: 'allow',
    reason: 'Tool allowed by explicit permission rule.',
    decisionReason: { type: 'rule', rule: allowRule },
  };
  return null;
}
