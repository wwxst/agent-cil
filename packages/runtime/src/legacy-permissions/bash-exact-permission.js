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
  return {
    behavior: 'passthrough',
    message: 'Permission to use Bash requires approval.',
    decisionReason: { type: 'other', reason: 'This command requires approval' },
  };
}
