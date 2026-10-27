/**
 * Source 2.1.88 BashTool.checkPermissions bridge using the ORIGINAL
 * parseForSecurity() + checkSemantics() and existing original
 * filterRulesByContentsMatchingInput(). This adds a missing AST gate,
 * NOT a new shell grammar or a substitute for source permissions.
 *
 * Broad prefix/wildcard auto-allow remains disabled pending source
 * checkPathConstraints()/redirection/sandbox integration.
 */
import { bashToolCheckExactMatchPermission } from './bash-exact-permission.js';
import { assessOriginalBashSecurity } from './bash-original-ast-security.js';
import { matchingRulesForInput } from './bash-original-rule-filter.js';

function sourceAsk(reason) {
  return {
    behavior:'ask',
    message:'Bash requires approval: '+reason,
    decisionReason:{type:'safetyCheck',reason:'Original Bash AST: '+reason},
  };
}
export async function bashToolCheckAstPermission(input,context) {
  // Preserve original exact deny > exact ask > prefix deny/ask and
  // wrapper/env fixed-point matcher. AST parsing must never override deny.
  const original=bashToolCheckExactMatchPermission(input,context);
  if(original.behavior==='deny' ||
     (original.behavior==='ask' &&
       original.decisionReason?.type==='rule')) return original;

  const parsed=await assessOriginalBashSecurity(input.command);
  if(parsed.kind!=='simple') {
    // Verbatim source 2.1.88 bashPermissions.ts:1431-1454
    // checkSemanticsDeny() sequence: checkEarlyExitDeny for the full
    // command (above), then match prefix/wildcard DENY for every
    // AST-extracted SimpleCommand even when semantic validation failed.
    // Without this, echo harmless && eval ... with Bash(eval:*) would
    // become an ordinary interactive ask rather than an explicit DENY.
    for(const cmd of parsed.sourceCommands??[]) {
      const match=matchingRulesForInput(
        {...input,command:cmd.text},context,'prefix',
        {skipCompoundCheck:true},
      ).matchingDenyRules[0];
      if(match!==undefined) {
        return {
          behavior:'deny',
          message:'Permission to use Bash with command '+
            input.command+' has been denied.',
          decisionReason:{type:'rule',rule:match},
        };
      }
    }
    return sourceAsk(parsed.reason??'Command cannot be safely parsed');
  }
  const commands=parsed.commands??[];
  // Compound commands are still not automatically allowed. The original
  // security walker exposes EACH verified subcommand, allowing source
  // restrictive rules to match node/rm hidden behind harmless commands,
  // pipelines, env prefixes and validated wrappers.
  let restrictiveAsk;
  if(commands.length>1) {
    for(const subcommand of commands) {
      const sub=bashToolCheckExactMatchPermission({
        command:subcommand.text,
      },context);
      if(sub.behavior==='deny')return sub;
      if(sub.behavior==='ask' &&
          sub.decisionReason?.type==='rule')restrictiveAsk??=sub;
    }
    return restrictiveAsk??sourceAsk(
      'Compound command requires original per-subcommand approval and path checks');
  }
  return original;
}
