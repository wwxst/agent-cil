/**
 * Ported from CLI 2.1.88:
 *   src/utils/permissions/permissionRuleParser.ts
 *   src/utils/permissions/permissions.ts (whole-tool rule matching/ordering).
 *
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * Node.js ESM, no Bun/UI/MCP dependency. Preserves the old parser's
 * escaped-parenthesis handling and deny > ask > allow precedence, but does
 * not implement content-specific Bash rules or MCP server wildcards.
 */

export function unescapeRuleContent(content) {
  return content.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
}

function findFirstUnescapedChar(str, char) {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') { backslashCount++; j--; }
      if (backslashCount % 2 === 0) return i;
    }
  }
  return -1;
}

function findLastUnescapedChar(str, char) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === '\\') { backslashCount++; j--; }
      if (backslashCount % 2 === 0) return i;
    }
  }
  return -1;
}

// Direct port of permissionRuleValueFromString(), excluding aliases of
// unavailable legacy-only Task/KillShell/AgentOutput tool registrations.
// Unknown legacy aliases therefore fail closed on this six-tool CLI.
export function permissionRuleValueFromString(ruleString) {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(');
  if (openParenIndex === -1) return { toolName: ruleString };
  const closeParenIndex = findLastUnescapedChar(ruleString, ')');
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex ||
      closeParenIndex !== ruleString.length - 1) return { toolName: ruleString };
  const toolName = ruleString.substring(0, openParenIndex);
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex);
  if (!toolName) return { toolName: ruleString };
  if (rawContent === '' || rawContent === '*') return { toolName };
  return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}

function getRules(context, ruleKind, behavior) {
  // Preserve original source attribution. There is no rule persistence or
  // automatic refresh; sources here are owned by permission context updates.
  return Object.entries(context?.[ruleKind] ?? {}).flatMap(([source, entries]) =>
    entries.map(ruleString => ({
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

function toolMatchesRule(tool, rule) {
  if (rule.ruleValue.ruleContent !== undefined) return false;
  // For this CLI, built-in name is also its canonical permission name.
  // The old MCP qualified tool-name helper will be ported with MCP support.
  return rule.ruleValue.toolName === tool.name;
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
