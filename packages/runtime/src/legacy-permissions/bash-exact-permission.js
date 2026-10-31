/**
 * CLI BashTool.checkPermissions bridge to original CLI 2.1.88
 * bashPermissions.ts:matchingRulesForInput()/filterRulesByContentsMatchingInput().
 *
 * Deny/ask decisions use original source rule matching in the original
 * exact-match-first, prefix-match-second order. Full output redirection,
 * compound parsing, path/sed constraints and native bashToolHasPermission()
 * are not yet connected. Scoped automatic allow remains fail-closed until
 * those original dependencies are ported, including dynamic substitutions.
 */
import { getRuleByContentsForToolName } from './permission-rules.js';
import { matchingRulesForInput } from './bash-original-rule-filter.js';
import { tryParseShellCommand, hasMalformedTokens, hasShellQuoteSingleQuoteBug } from './bash-shell-quote.js';

function ruleDecision(behavior, rule, command) {
  return {
    behavior,
    message: behavior === 'deny'
      ? 'Permission to use Bash with command ' + command + ' has been denied.'
      : 'Permission to use Bash requires approval.',
    decisionReason: { type: 'rule', rule },
  };
}

export function bashToolCheckExactMatchPermission(input, toolPermissionContext) {
  const command = input.command.trim();
  const denyRules = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'deny');
  const askRules = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'ask');

  // Original BashTool order: exact deny, exact ask, then prefix/wildcard
  // deny/ask, before any allow. Prefix matching cannot be used as an
  // allow in the current bridge (full splitCommand AST closure absent).
  const exact = matchingRulesForInput(input, toolPermissionContext, 'exact');
  if (exact.matchingDenyRules[0] !== undefined) {
    return ruleDecision('deny', exact.matchingDenyRules[0], command);
  }
  if (exact.matchingAskRules[0] !== undefined) {
    return ruleDecision('ask', exact.matchingAskRules[0], command);
  }
  const prefix = matchingRulesForInput(input, toolPermissionContext, 'prefix', {
    // This option is used ONLY because prefix auto-allow is not consumed.
    // Original deny/ask matching already forces skipCompoundCheck=true.
    // Once original splitCommand is ported, use its full native call chain.
    skipCompoundCheck: true,
  });
  if (prefix.matchingDenyRules[0] !== undefined) {
    return ruleDecision('deny', prefix.matchingDenyRules[0], command);
  }
  if (prefix.matchingAskRules[0] !== undefined) {
    return ruleDecision('ask', prefix.matchingAskRules[0], command);
  }

  // Original utils/bash/shellQuote.ts parser differential and malformed token
  // guards. The old bashToolHasPermission() runs its shell-quote pre-check
  // before any automatic authorization when AST parsing is unavailable.
  // Check restrictive rules FIRST so parser complexity cannot downgrade a
  // matching explicit deny to a generic ask (source checkEarlyExitDeny).
  const parsed = tryParseShellCommand(command, name => String.fromCharCode(36) + name);
  const suspicious = hasShellQuoteSingleQuoteBug(command) ||
    !parsed.success ||
    (parsed.success && hasMalformedTokens(command, parsed.tokens));
  if (suspicious) {
    return {
      behavior: 'ask',
      message: 'Bash command requires approval because the shell syntax cannot be safely verified.',
      decisionReason: { type: 'safetyCheck', reason: 'Original shellQuote security validation' },
    };
  }

  // The original bashToolHasPermission() also runs AST semantic checks,
  // checkPathConstraints() and output redirect handling before granting an
  // exact allow. Until these mature components are ported, never allow
  // redirects, pipelines, subshells, or compound control operators solely
  // because a whole literal Bash(command) rule matched.
  const unsafeOperators = new Set([
    '>', '>>', '<', '<<', '<<<', '>&', '<&', '&>',
    '|', '|&', '&&', '||', ';', '&', '(', ')',
  ]);
  if (/[\r\n]/.test(command) || /[<>]/.test(command) ||
      parsed.tokens.some(token => token && typeof token === 'object' &&
        'op' in token && unsafeOperators.has(token.op))) {
    return {
      behavior: 'ask',
      message: 'Bash command requires approval until original compound, redirect and path constraints are available.',
      decisionReason: { type: 'safetyCheck', reason: 'Unported original Bash AST/path validation' },
    };
  }

  // If any deny/ask content rule exists, we cannot prove it was not hidden
  // behind a redirection, a shell compound, a dynamic expansion or wrapper
  // unsupported by the old parser closure. Never promote exact allow.
  if (denyRules.size > 0 || askRules.size > 0) {
    return {
      behavior: 'ask',
      message: 'Bash command needs review because content-specific restrictions are configured.',
      decisionReason: { type: 'safetyCheck', reason: 'Unported Bash AST/redirect/compound constraints' },
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
