/**
 * Node CLI permission bridge for the original BashTool checkPermissions stage.
 * Sources: 2.1.88 bashPermissions.ts:matchingRulesForInput,
 * bashToolCheckExactMatchPermission, and shellRuleMatching.ts.
 *
 * Permission *denials and asks* can match source exact/prefix/wildcard syntax;
 * those decisions cannot increase authority. For an allow, only literal full
 * commands are supported until original AST, wrapper, path and compound
 * analysis is available. When ANY scoped deny/ask exists, automatic
 * command-level allow is withheld: wrappers/env substitutions cannot safely
 * be excluded by the unported source dependency closure. Ask is safer than
 * accidentally bypassing an administrator's restricted rule.
 */
import { getRuleByContentsForToolName } from './permission-rules.js';
import { parsePermissionRule, matchWildcardPattern } from './shell-rule-matching.js';
import { stripSafeWrappers, stripAllLeadingEnvVars } from './bash-rule-candidates.js';

/**
 * 2.1.88 bashPermissions.ts:filterRulesByContentsMatchingInput() uses a
 * fixed-point expansion of stripSafeWrappers and stripAllLeadingEnvVars for
 * deny/ask rules. Preserve that source strategy and function names so even
 * interleaved wrappers such as "nohup FOO=bar timeout 5 rm" are restricted.
 *
 * This limited stage deliberately does not use these candidates to permit
 * execution, and it does not claim to replace the original shell-quote,
 * extractOutputRedirections(), splitCommand() or AST validation.
 */
function restrictedCandidates(command) {
  const commandsToTry = [command];
  const seen = new Set(commandsToTry);
  let startIdx = 0;
  while (startIdx < commandsToTry.length) {
    const endIdx = commandsToTry.length;
    for (let i = startIdx; i < endIdx; i++) {
      const candidate = commandsToTry[i];
      if (!candidate) continue;
      for (const stripped of [
        stripSafeWrappers(candidate),
        stripAllLeadingEnvVars(candidate),
      ]) {
        if (stripped && !seen.has(stripped)) {
          seen.add(stripped);
          commandsToTry.push(stripped);
        }
      }
    }
    startIdx = endIdx;
  }
  return commandsToTry;
}

// The rule-type switch and word boundaries come from 2.1.88
// bashPermissions.ts:filterRulesByContentsMatchingInput().
function findRestrictedRule(rules, commandsToTry) {
  for (const [content, rule] of rules) {
    const shellRule = parsePermissionRule(content);
    for (const command of commandsToTry) {
      if (shellRule.type === 'exact' && shellRule.command === command) return rule;
      if (shellRule.type === 'prefix' && (
        command === shellRule.prefix ||
        command.startsWith(shellRule.prefix + ' ') ||
        command === 'xargs ' + shellRule.prefix ||
        command.startsWith('xargs ' + shellRule.prefix + ' ')
      )) return rule;
      if (shellRule.type === 'wildcard' &&
        matchWildcardPattern(shellRule.pattern, command)) return rule;
    }
  }
  return undefined;
}

export function bashToolCheckExactMatchPermission(input, toolPermissionContext) {
  const command = input.command.trim();
  const denyRules = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'deny');
  const askRules = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'ask');
  const candidates = restrictedCandidates(command);
  const deny = findRestrictedRule(denyRules, candidates);
  if (deny) {
    return {
      behavior: 'deny',
      message: 'Permission to use Bash with command ' + command + ' has been denied.',
      decisionReason: { type: 'rule', rule: deny },
    };
  }
  const ask = findRestrictedRule(askRules, candidates);
  if (ask) {
    return {
      behavior: 'ask',
      message: 'Permission to use Bash requires approval.',
      decisionReason: { type: 'rule', rule: ask },
    };
  }
  const hasRestrictiveContentRules = denyRules.size > 0 || askRules.size > 0;
  // Exact allow must NOT override a deny that the original env/wrapper/AST
  // stage would recognize but this partial bridge cannot yet analyze.
  // This includes e.g. a denied 'node --version' hidden by FOO=1 while a
  // separate exact allow for 'FOO=1 node --version' is configured.
  if (hasRestrictiveContentRules) {
    return {
      behavior: 'ask',
      message: 'Bash command needs review because content-specific restrictions are configured.',
      decisionReason: { type: 'safetyCheck', reason: 'Unported Bash compound/wrapper analysis' },
    };
  }
  const allow = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'allow').get(command);
  if (allow) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'rule', rule: allow },
    };
  }
  return {
    behavior: 'passthrough',
    message: 'Permission to use Bash requires approval.',
    decisionReason: { type: 'other', reason: 'This command requires approval' },
  };
}
