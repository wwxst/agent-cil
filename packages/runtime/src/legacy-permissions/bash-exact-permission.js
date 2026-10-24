/**
 * Source-first exact-command slice of CLI 2.1.88
 * tools/BashTool/bashPermissions.ts:bashToolCheckExactMatchPermission().
 *
 * The complete legacy bashToolHasPermission() also parses compound commands,
 * redirects, prefixes, wildcards and path/sandbox restrictions. Until those
 * original dependency closures are ported, the CLI accepts only literal,
 * exact Bash(content) rules and does not generalize them to compound parts,
 * wrappers, shell expansions or command prefixes. This module MUST NOT be
 * presented as full Bash permission equivalence.
 */
import { getRuleByContentsForToolName } from './permission-rules.js';

export function bashToolCheckExactMatchPermission(input, toolPermissionContext) {
  const command = input.command.trim();
  const deny = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'deny').get(command);
  if (deny) {
    return {
      behavior: 'deny',
      message: 'Permission to use Bash with command ' + command + ' has been denied.',
      decisionReason: { type: 'rule', rule: deny },
    };
  }
  const ask = getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'ask').get(command);
  if (ask) {
    return {
      behavior: 'ask',
      message: 'Permission to use Bash requires approval.',
      decisionReason: { type: 'rule', rule: ask },
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
  // This restricted source slice does not yet decompose wrappers,
  // redirections and compounds. When a whole-tool Bash allow coexists with
  // a command-level deny/ask, unknown command shapes must require review:
  // never let "VAR=x denied_command" bypass a content-specific deny merely
  // because our unported source matcher did not recognize the wrapper.
  const hasRestrictiveContentRules =
    getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'deny').size > 0 ||
    getRuleByContentsForToolName(toolPermissionContext, 'Bash', 'ask').size > 0;
  if (hasRestrictiveContentRules) {
    return {
      behavior: 'ask',
      message: 'Bash command needs review because content-specific restrictions are configured.',
      decisionReason: { type: 'safetyCheck', reason: 'Unported Bash compound command analysis' },
    };
  }
  return {
    behavior: 'passthrough',
    message: 'Permission to use Bash requires approval.',
    decisionReason: { type: 'other', reason: 'This command requires approval' },
  };
}
