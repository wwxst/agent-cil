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
import {checkDangerousRemovalPaths} from './bash-original-dangerous-path.js';
import {stripWrappersFromArgv} from './generated/stripWrappers.js';

function sourceAsk(reason) {
  return {
    behavior:'ask',
    message:'Bash requires approval: '+reason,
    decisionReason:{type:'safetyCheck',reason:'Original Bash AST: '+reason},
  };
}
export async function bashToolCheckAstPermission(input,context,{workspace=process.cwd()}={}) {
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
  // Original BashTool/pathValidation.ts: validateSinglePathCommandArgv()
  // → stripWrappersFromArgv() → createPathChecker(rm/rmdir)
  // → checkDangerousRemovalPaths(). The mature source intentionally runs
  // this even when exact or whole-tool permission rules would allow Bash.
  // Never auto-allow removal of /, home, root children or drive roots.
  for(const command of commands){
    const argv=stripWrappersFromArgv(command.argv);
    if(argv[0]==='rm'||argv[0]==='rmdir'){
      const dangerous=checkDangerousRemovalPaths(argv[0],argv.slice(1),workspace);
      if(dangerous.behavior!=='passthrough')return dangerous;
    }
  }
  // Source 2.1.88 checkPathConstraints() validates each AST redirect
  // target BEFORE allowing a Bash rule. That full filesystem/sandbox
  // context is still being transplanted. Until its original validatePath()
  // dependency closure is connected, do not accept a whole-tool or exact
  // allow as authorization for unverified shell input/output redirection.
  // The original parser's Redirect[] is authoritative; never match raw
  // command strings or improvise a permissive shell grammar here.
  if(commands.some(command=>(command.redirects??[]).length>0)) {
    return sourceAsk('Shell redirection needs original checkPathConstraints target validation');
  }
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
