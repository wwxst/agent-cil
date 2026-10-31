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
import {
  isOriginalBashPathCommand,getOriginalBashPathExtractor,
  getOriginalBashPathOperationType,
} from './original-bash-command-paths.js';
import {validateBashReadPath,hasOriginalReadScopedRules,checkOriginalWritePathSafety,checkOriginalEditScopedRules,hasOriginalEditScopedRules} from './original-bash-read-paths.js';
import {statSync} from 'node:fs';
import {getRuleByContentsForToolName,toolAlwaysAllowedRule} from './permission-rules.js';
import {checkOriginalAstRedirections} from './original-bash-redirections.js';
import {validateOriginalBashPathCommand,getNewerBashExtraGlobPaths} from './original-bash-command-paths.js';
import {sedCommandIsAllowedByAllowlist,checkSedConstraints} from './original-bash-sed-validation.js';
import {stripSafeWrappers} from './bash-rule-candidates.js';
import {checkPermissionMode} from './original-bash-mode-validation.js';
import {checkOriginalReadOnlyRegexBranch} from './original-bash-readonly-regex.js';
import {checkOriginalCompoundReadOnlyConstraints} from './original-bash-readonly-compound.js';
import {checkOriginalBashMisparsingSafety} from './original-bash-safety-prefilter.js';
import {checkOriginalBashFurtherMisparsing} from './original-bash-safety-further.js';
import {checkOriginalBashFlagObfuscation,checkOriginalZshDangerousCommands}
  from './original-bash-obfuscated-flags.js';
import {checkOriginalJqCommandSecurity} from './original-bash-jq-validation.js';
import {checkNewerBashFindAwkSemantics} from './original-bash-find-awk-semantics.js';
import {checkNewerBashAstLexicalPreflight} from './newer-bash-ast-lexical-preflight.js';

function sourceAsk(reason) {
  return {
    behavior:'ask',
    message:'Bash requires approval: '+reason,
    decisionReason:{type:'safetyCheck',reason:'Original Bash AST: '+reason},
  };
}
export async function bashToolCheckAstPermission(input,context,{workspace=process.cwd(),readOnlyOnly=false}={}) {
  // Preserve exact full-command DENY immediately. A full-command ASK is
  // deferred until every verified AST leaf has had its deny rules checked:
  // an ask such as Bash(*echo*) must not hide Bash(rm:*) later in the command.
  const original=bashToolCheckExactMatchPermission(input,context);
  if(original.behavior==='deny')return original;
  const originalRuleAsk=original.behavior==='ask' &&
    original.decisionReason?.type==='rule' ? original : undefined;
  // The exact-rule adapter emits these two temporary safety markers because
  // it cannot itself consume the original AST/path dependency closure. Once
  // the pinned 2.1.88 AST is simple, we can safely re-evaluate both through
  // the real semantic, per-leaf deny/ask, redirection and path gates below.
  // Shell-quote/parser-differential and every other safety ask remain closed.
  const originalSafetyReason=original.decisionReason?.reason;
  const canReevaluateOriginalSafetyAsk=
    originalSafetyReason==='Unported original Bash AST/path validation' ||
    originalSafetyReason==='Unported Bash AST/redirect/compound constraints';
  if(original.behavior==='ask' &&
     original.decisionReason?.type==='safetyCheck' &&
     !canReevaluateOriginalSafetyAsk)
    return original;
  // Source 2.1.88 bashSecurity.ts: bashCommandIsSafe_DEPRECATED()
  // misparsing checks are EARLY blockers even for an exact Bash allow.
  // Explicit user deny/ask above still takes precedence.
  const misparsing=checkOriginalBashMisparsingSafety(input.command);
  if(misparsing.behavior!=='passthrough')return {
    ...misparsing,
    decisionReason:{type:'safetyCheck',reason:misparsing.message},
  };
  // Pinned bashSecurity.ts validator is earlier than IFS/proc/brace/etc.
  // It catches concatenated quoted flag names, ANSI-C/locale quotes and
  // dangerous flag-smuggling before any original AST or mode grant.
  const obfuscated=checkOriginalBashFlagObfuscation(input.command);
  if(obfuscated.behavior!=='passthrough')return {
    ...obfuscated,
    decisionReason:{type:'safetyCheck',reason:obfuscated.message},
  };
  // Direct original Bash source IFS/proc/brace/hash/malformed-token gate.
  // Match after explicit rule deny/ask but before any AST/mode/read-only allow.
  const further=checkOriginalBashFurtherMisparsing(input.command);
  if(further.behavior!=='passthrough')return {
    ...further,
    decisionReason:{type:'safetyCheck',reason:further.message},
  };
  // Source's Zsh dangerous command check remains a mandatory safety
  // validator even though current CLI runs Bash/cmd (future-proofed).
  const zsh=checkOriginalZshDangerousCommands(input.command);
  if(zsh.behavior!=='passthrough')return {
    ...zsh,
    decisionReason:{type:'safetyCheck',reason:zsh.message},
  };
  // CLI 2.1.304 zK() AST prechecks run before parsing trusts command
  // boundaries. The pinned 2.1.88 AST lacks ONLY these two verified
  // lexical predicates; keep the old parser, rule precedence, denial
  // matching, and all existing mature security checks unmodified.
  const newerLexical=checkNewerBashAstLexicalPreflight(input.command);
  if(newerLexical.kind!=='passthrough')
    return sourceAsk(newerLexical.reason);
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
    if(originalRuleAsk)return originalRuleAsk;
    return sourceAsk(parsed.reason??'Command cannot be safely parsed');
  }
  const commands=parsed.commands??[];
  // Source bashPermissions.ts checks restrictive rules for every AST leaf
  // before checkPathConstraints. Continue across ASK matches so a later
  // explicit DENY cannot be downgraded by an earlier full-command/subcommand
  // ASK. AST leaf text excludes redirects; those targets are checked
  // independently by checkOriginalAstRedirections below.
  let restrictiveAsk=originalRuleAsk;
  const leafPermissionResults=new Map();
  for(const command of commands){
    if(typeof command.text!=='string'||!command.text.trim())continue;
    const sub=bashToolCheckExactMatchPermission(
      {...input,command:command.text},context,
    );
    leafPermissionResults.set(command.text,sub);
    if(sub.behavior==='deny')return sub;
    if(sub.behavior==='ask' && sub.decisionReason?.type==='rule')
      restrictiveAsk??=sub;
  }
  if(restrictiveAsk)return restrictiveAsk;
  // Original 2.1.88 checkCommandOperatorPermissions blocks subshells and
  // command groups before exact/prefix/mode grants. The AST walker extracts
  // their inner commands for deny analysis, but that extraction must never
  // turn an unsafe compound structure into automatic authorization.
  if(parsed.compoundStructure?.hasSubshell ||
     parsed.compoundStructure?.hasCommandGroup)
    return sourceAsk('This command uses shell operators that require approval for safety');
  // Pinned 2.1.88 bashPermissions.ts: multiple directory changes and
  // cd/pushd/popd combined with git are explicit approval boundaries. Run
  // these after AST-leaf deny/ask checks but before any path or exact allow.
  if(commands.length>1) {
    const commandBase=command=>stripWrappersFromArgv(command.argv??[])[0]??'';
    const directoryChanges=commands.filter(command=>
      ['cd','pushd','popd'].includes(commandBase(command)));
    if(directoryChanges.length>1)
      return sourceAsk('Multiple directory changes in one command require approval for clarity');
    const hasGitCommand=commands.some(command=>{
      const argv=stripWrappersFromArgv(command.argv??[]);
      return argv[0]==='git'||(argv[0]==='xargs'&&argv.includes('git'));
    });
    if(directoryChanges.length>0&&hasGitCommand)
      return sourceAsk('Compound commands with cd and git require approval to prevent bare repository attacks');
  }
  // The original 2.1.88 windowsPaths.ts helper recognizes Cygwin's
  // /cygdrive/C/... spelling, but original utils/path.ts#expandPath()
  // deliberately routes only /C/... through that converter. The real
  // Windows CLI launches POSIX Git Bash (MSYS2), whose default drive mounts
  // use /C rather than Cygwin's /cygdrive/C. Treating these namespaces as
  // interchangeable would authorize the wrong native filesystem target.
  // Consume only the original AST's literal argv/redirect targets, not a
  // string-split shell approximation. Do not upgrade any Bash exact/whole-
  // tool allow for an unverified Cygwin path; keep the original ask boundary.
  if(process.platform==='win32') {
    const unverified=path=>typeof path==='string' &&
      /^\/cygdrive\/[A-Za-z](?:\/|$)/i.test(path);
    if(commands.some(cmd=>
      (cmd.argv??[]).some(unverified)||
      (cmd.redirects??[]).some(redirect=>unverified(redirect.target))))
      return sourceAsk('Cygwin /cygdrive/ paths are not verified Git Bash filesystem mounts');
  }
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
  // Original 2.1.88 bashSecurity.ts:validateJqCommand, completed with
  // 2.1.304 argv checks from chunk-jfhbcs0s.js (include/import and joined
  // -f/-L flags). Evaluate source-verified AST leaves, including after env/
  // timeout wrappers, BEFORE any Bash exact/mode/read-only auto-allow.
  // Explicit full-command rule denials above remain authoritative.
  for(const command of commands){
    const argv=stripWrappersFromArgv(command.argv);
    const jq=checkOriginalJqCommandSecurity(command.text,argv);
    if(jq.behavior!=='passthrough')return {
      ...jq,decisionReason:{type:'safetyCheck',reason:jq.message},
    };
  }
  // CLI 2.1.304 find/awk semantic checks run on original verified AST
  // leaf argv. Exact/whole-tool Bash permission and acceptEdits must not
  // bypass find -delete/-exec or awk system()/script-loading checks.
  for(const command of commands){
    const argv=stripWrappersFromArgv(command.argv);
    const checked=checkNewerBashFindAwkSemantics(argv,command);
    if(checked.behavior!=='passthrough')return {
      ...checked,decisionReason:{type:'safetyCheck',reason:checked.message},
    };
  }
  // Original BashTool.checkPathConstraints() AST classification, now
  // source-checked before any Bash exact or whole-tool allow takes effect.
  // Writes still require original create permission before auto execution.
  const redirectDecision=checkOriginalAstRedirections(commands,workspace,context);
  if(redirectDecision.behavior!=='passthrough')return redirectDecision;

  // Old BashTool.checkPathConstraints(): AST argv → stripWrappersFromArgv()
  // → COMMAND_VALIDATOR/PATH_EXTRACTORS → validatePath(). Until the complete
  // original validatePath filesystem/deny/sandbox closure is available, do
  // not let Bash(command) exact or whole-tool allow silently bypass it.
  // Extractors/validators are generated verbatim from pinned 2.1.88 source.
  // No new shell parsing or permissive workspace path approximation.
  const scopedReadRestrictions=hasOriginalReadScopedRules(context);
  const scopedEditRestrictions=hasOriginalEditScopedRules(context);
  for(const command of commands){
    const argv=stripWrappersFromArgv(command.argv);
    const [base,...args]=argv;
    if(!isOriginalBashPathCommand(base)){
      // Original scoped Read deny/ask rules cannot be enforced on a command
      // with unknown file effects (e.g. an interpreter opening secret files).
      // Whole Bash allow must not silently bypass those rules.
      if(scopedReadRestrictions||scopedEditRestrictions)
        return sourceAsk('Unclassified Bash command requires approval under scoped file permissions');
      continue;
    }
    // Pinned BashTool/pathValidation.ts:validateSinglePathCommandArgv()
    // overrides sed 'write' ONLY when the full source read-only allowlist
    // validates a print-only command. Do not reinterpret sed syntax here.
    const strippedText=base==='sed'?stripSafeWrappers(command.text):'';
    const isSafeSedRead=base==='sed'&&
      sedCommandIsAllowedByAllowlist(strippedText);
    if(base==='sed'){
      // Source sedValidation.ts:checkSedConstraints must run regardless
      // of explicit Bash allow, acceptEdits mode or filename permissions.
      // In acceptEdits it separately allows safe in-place substitutions.
      const sedCheck=checkSedConstraints(strippedText,context);
      if(sedCheck.behavior!=='passthrough')return sedCheck;
    }
    const pathExtractor=getOriginalBashPathExtractor(base);
    const extractedPaths=pathExtractor(args);
    const operationType=isSafeSedRead?'read':getOriginalBashPathOperationType(base);
    const teeHasNoFileTargets=base==='tee' && extractedPaths.length===0;
    if(scopedEditRestrictions && operationType!=='read' &&
       extractedPaths.length===0 && !teeHasNoFileTargets)
      return sourceAsk('Bash implicit write target requires original Edit(path) validation');
    if(scopedReadRestrictions && operationType==='read' && extractedPaths.length===0)
      return sourceAsk('Bash implicit read requires original Read(path) filtering');
    const compoundCommandHasCd=commands.some(c=>['cd','pushd','popd'].includes(
      stripWrappersFromArgv(c.argv??[])[0]??''));
    // 2.1.304 pathValidation.ts adds shell-expanded glob argv values that the
    // command-specific extractor did not recognize. Use the original AST's
    // per-argv provenance; the path adapter falls back conservatively only
    // when wrapper stripping or an unsupported AST form loses alignment.
    const extraGlobPaths=getNewerBashExtraGlobPaths(base,args,command);
    // Preserve the newer path checker precedence: an explicit Read deny on
    // an extra path must not be hidden behind an earlier ask for another path.
    for(const path of extraGlobPaths){
      const normalized=validateBashReadPath(path,workspace,context);
      if(!normalized.allowed &&
         normalized.decisionReason?.type==='rule' &&
         normalized.decisionReason.rule?.ruleBehavior==='deny'){
        return {
          behavior:'deny',
          message:base+" in '"+normalized.resolvedPath+"' was blocked by a deny rule.",
          decisionReason:normalized.decisionReason,
        };
      }
    }
    const checked=validateOriginalBashPathCommand(base,args,workspace,context,{
      compoundCommandHasCd,
      operationTypeOverride:isSafeSedRead?'read':undefined,
      extraReadPaths:extraGlobPaths,
    });
    if(checked.behavior!=='passthrough')return checked;
    // A path command whose source extractor reads a directory or glob
    // still needs per-file scoped Read filtering to prevent descendant
    // Read(path) denies from being bypassed.
    // cd resolves a directory operand but does not enumerate/read that
    // directory. Do not route it through the per-file directory-read guard;
    // relative file readers later in the compound command are checked by
    // validateCommandPaths(compoundCommandHasCd), including the 2.1.304
    // relative-read-after-cd rule.
    if(scopedReadRestrictions && operationType==='read' && base!=='cd'){
      for(const path of extractedPaths){
        const normalized=validateBashReadPath(path,workspace,context);
        if(!normalized.allowed)continue; // denied already by source path checker
        try{
          if(statSync(normalized.resolvedPath).isDirectory())
            return sourceAsk('Bash directory read needs per-file Read(path) checks');
        }catch{
          return sourceAsk('Bash unresolved read path needs per-file Read(path) checks');
        }
      }
    }
  }
  // Original 2.1.88 BashTool.isReadOnly() is checked AFTER source
  // semantics/path/redirection/explicit rules. Plan mode previously
  // blocked every Bash call at CLI policy level, including safe 'echo'
  // and 'pwd'. This read-only-only gate restores that mature source
  // branch without granting whole Bash(command), acceptEdits, uncertain
  // compound command, redirect or source-prefix allow in plan mode.
  // The caller must deny any non-allow result; an ask is not a plan grant.
  if(readOnlyOnly){
    if(commands.length!==1 || (commands[0].redirects?.length??0)>0)
      return sourceAsk('Plan mode requires a single source-validated read-only Bash command without redirections');
    const readonly=checkOriginalReadOnlyRegexBranch(input.command,{
      workspace,originalCwd:workspace,sandboxEnabled:false,
    });
    if(readonly.behavior==='allow')return {...readonly,updatedInput:input};
    return sourceAsk('Plan mode Bash command was not proven read-only by original 2.1.88 validation');
  }
  if(commands.length>1) {
    // The original 2.1.88 exact full-command allow is checked only AFTER
    // every subcommand's deny/ask, semantic, redirect and path validation.
    // Restore it only for a source-verified simple && list; do not infer
    // pipeline, background, newline or redirect semantics from string splitting.
    const normalizeSourceText=value=>value.trim().replace(/\s+/g,' ');
    const exactSequentialAndList=
      normalizeSourceText(input.command)===
      normalizeSourceText(commands.map(command=>command.text).join(' && '));
    if(exactSequentialAndList &&
       original.behavior==='ask' &&
       original.decisionReason?.type==='safetyCheck' &&
       (original.decisionReason.reason==='Unported original Bash AST/path validation' ||
        original.decisionReason.reason==='Unported Bash AST/redirect/compound constraints')){
      const rule=getRuleByContentsForToolName(context,'Bash','allow')
        .get(input.command.trim());
      if(rule)return {
        behavior:'allow',updatedInput:input,
        decisionReason:{type:'rule',rule},
      };
    }
    // Source 2.1.88 bashToolCheckPermission runs exact/prefix rules and
    // checkPermissionMode for EACH validated subcommand. Restore the mode path
    // only when every AST leaf is independently covered by an exact allow,
    // prefix allow, or an acceptEdits filesystem-command grant. Path, jq,
    // find/awk, rm, redirect and restrictive-rule checks have already run.
    const modeSubcommandResults=new Map();
    let allModeSubcommandsAllowed=true;
    for(const command of commands){
      const exact=leafPermissionResults.get(command.text);
      if(exact?.behavior==='allow'){
        modeSubcommandResults.set(command.text,exact);
        continue;
      }
      const prefixAllow=matchingRulesForInput(
        {...input,command:command.text},context,'prefix',
        {skipCompoundCheck:true},
      ).matchingAllowRules[0];
      if(prefixAllow!==undefined){
        modeSubcommandResults.set(command.text,{
          behavior:'allow',updatedInput:{...input,command:command.text},
          decisionReason:{type:'rule',rule:prefixAllow},
        });
        continue;
      }
      const modeResult=checkPermissionMode(
        {...input,command:command.text},context,[command.text],
      );
      if(modeResult.behavior==='allow'){
        modeSubcommandResults.set(command.text,modeResult);
        continue;
      }
      // Source BashTool.isReadOnly() is evaluated per segment too. Reuse the
      // pinned safe-regex branch for ordinary read-only leaves in a mixed
      // read/write chain, but do not grant directory changes or Git here:
      // those require the complete compound cwd/bare-repository closure below.
      const argv=stripWrappersFromArgv(command.argv??[]);
      const base=argv[0]??'';
      const changesDirectory=['cd','pushd','popd'].includes(base);
      const invokesGit=base==='git'||(base==='xargs'&&argv.includes('git'));
      if(process.platform!=='win32'&&!changesDirectory&&!invokesGit){
        const readOnly=checkOriginalReadOnlyRegexBranch(command.text,{
          workspace,originalCwd:workspace,sandboxEnabled:false,
        });
        if(readOnly.behavior==='allow'){
          modeSubcommandResults.set(command.text,readOnly);
          continue;
        }
      }
      allModeSubcommandsAllowed=false;
      break;
    }
    if(allModeSubcommandsAllowed)
      return {
        behavior:'allow',updatedInput:input,
        decisionReason:{type:'subcommandResults',reasons:modeSubcommandResults},
      };
    // Restore the source whole-tool Bash grant only after every verified AST
    // leaf, redirect, semantic and path constraint has passed.
    const wholeToolAllow=toolAlwaysAllowedRule(context,{name:'Bash'});
    if(wholeToolAllow && original.behavior==='ask' &&
       original.decisionReason?.type==='safetyCheck' &&
       (original.decisionReason.reason==='Unported original Bash AST/path validation' ||
        original.decisionReason.reason==='Unported Bash AST/redirect/compound constraints')){
      return {behavior:'allow',updatedInput:input,
        decisionReason:{type:'rule',rule:wholeToolAllow}};
    }
    // Pinned 2.1.88 checkReadOnlyConstraints: all individual source-validated
    // read-only subcommands may be approved only after the existing original
    // AST semantics, path/redirection, explicit deny/ask and bare-Git gates.
    if(context.mode!=='plan' && original.decisionReason?.type!=='rule' &&
       (original.behavior!=='ask' ||
        original.decisionReason?.reason==='Unported original Bash AST/path validation')){
      const readOnly=checkOriginalCompoundReadOnlyConstraints(input,commands,{
        workspace,originalCwd:workspace,sandboxEnabled:false,
      });
      if(readOnly.behavior==='allow')return readOnly;
    }
    return sourceAsk(
      'Compound command requires original per-subcommand approval and path checks');
  }
  // A command-specific Bash allow may match the AST leaf even when the
  // original full command carries a temporary redirect safety ASK. Restore
  // that exact leaf decision only after independent redirect and path checks.
  const singleLeafPermission = commands.length === 1
    ? leafPermissionResults.get(commands[0].text)
    : undefined;
  if(original.behavior==='ask' &&
     original.decisionReason?.type==='safetyCheck' &&
     canReevaluateOriginalSafetyAsk &&
     singleLeafPermission?.behavior==='allow'){
    return {...singleLeafPermission,updatedInput:input};
  }
  // Original bashPermissions.ts step 6: mode-specific filesystem
  // permission after all AST, path, explicit deny/ask, sed and rm checks.
  // Pass authoritative AST leaf text rather than deprecated shell splitting.
  // Exact Bash allow remains the earlier source step 4, ahead of mode.
  if(original.behavior!=='allow' &&
     !(original.behavior==='ask'&&original.decisionReason?.type==='rule')){
    const modeResult=checkPermissionMode(input,context,
      commands.map(cmd=>cmd.text));
    if(modeResult.behavior!=='passthrough')
      return {...modeResult,updatedInput:input};
  }
  // 2.1.88 readOnlyValidation.ts original regex branch (step 7).
  // Only source-proven SINGLE leaf commands, after the original AST,
  // redirect and per-path gates above. Complex flag allowlists, compound
  // shell text and plan-mode escape cannot be assumed read-only.
  if(context.mode!=='plan' && original.behavior!=='allow' &&
     original.decisionReason?.type!=='rule' &&
     commands.length===1 && !(commands[0].redirects?.length)){
    const readonly=checkOriginalReadOnlyRegexBranch(input.command,{
      workspace,originalCwd:workspace,sandboxEnabled:false,
    });
    if(readonly.behavior==='allow')return {...readonly,updatedInput:input};
  }
  // Restore exact and whole-tool Bash grants only after the parsed AST,
  // semantic, redirection and path gates have all passed. Malformed syntax,
  // explicit deny/ask and other safety decisions remain closed.
  if(original.behavior==='ask' &&
     original.decisionReason?.type==='safetyCheck' &&
     (original.decisionReason.reason==='Unported original Bash AST/path validation' ||
      original.decisionReason.reason==='Unported Bash AST/redirect/compound constraints')){
    const exactRule=getRuleByContentsForToolName(context,'Bash','allow')
      .get(input.command.trim());
    if(exactRule)return {behavior:'allow',updatedInput:input,
      decisionReason:{type:'rule',rule:exactRule}};
    const wholeToolRule=toolAlwaysAllowedRule(context,{name:'Bash'});
    if(wholeToolRule)return {behavior:'allow',updatedInput:input,
      decisionReason:{type:'rule',rule:wholeToolRule}};
  }
  return original;
}
