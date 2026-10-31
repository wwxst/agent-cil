/**
 * Pinned CLI 2.1.88 BashTool/pathValidation.ts AST-derived redirection path.
 * astRedirectsToOutputRedirections() below is copied verbatim with TS types
 * removed. The original parser already checks shell substitution and AST
 * semantics before this bridge runs.
 *
 * Safe output creation now calls the old validatePath(create)/isPathAllowed
 * source chain after scoped Edit deny, full source auto-edit path safety,
 * and explicit ask. The CLI still has no sandbox or internal auto-grants,
 * so missing permissions ask rather than synthesizing an allow.
 */
import {isAbsolute} from 'node:path';
import {stripWrappersFromArgv} from './generated/stripWrappers.js';
import {checkOriginalEditScopedRules,checkOriginalWritePathSafety,validateBashReadPath,validateBashCreatePath} from './original-bash-read-paths.js';

const SAFE_INPUT_STREAM_TARGETS=new Set([
  '/dev/null','/dev/stdin','/dev/stdout','/dev/stderr','/dev/tty',
]);
function isSafeInputStreamTarget(target){
  return SAFE_INPUT_STREAM_TARGETS.has(target)||
    /^\/dev\/fd\/\d+$/.test(target)||
    /^\/proc\/self\/fd\/[0-2]$/.test(target);
}
function hasGlobRedirectTarget(target){
  for(let i=0;i<target.length;i++){
    const ch=target[i];
    if(ch==='*'||ch==='?')return true;
    if(ch==='['&&target.indexOf(']',i+1)!==-1)return true;
  }
  return false;
}

function sourceAsk(reason){
  return {behavior:'ask',message:'Bash redirection requires approval: '+reason,
    decisionReason:{type:'other',reason}};
}
function astRedirectsToOutputRedirections(redirects) {
  const redirections = []
  for (const r of redirects) {
    switch (r.op) {
      case '>':
      case '>|':
      case '&>':
        redirections.push({ target: r.target, operator: '>' })
        break
      case '>>':
      case '&>>':
        redirections.push({ target: r.target, operator: '>>' })
        break
      case '>&':
        // >&N (digits only) is fd duplication (e.g. 2>&1, >&10), not a file
        // write. >&file is the deprecated form of &>file (redirect to file).
        if (!/^\d+$/.test(r.target)) {
          redirections.push({ target: r.target, operator: '>' })
        }
        break
      case '<':
      case '<<':
      case '<&':
      case '<<<':
        // input redirects — skip
        break
    }
  }
  // AST targets are fully resolved (no shell expansion) — checkSemantics
  // already validated them. No dangerous redirections are possible.
  return { redirections, hasDangerousRedirection: false }
}

function validateOutputRedirections(redirections,cwd,context,compoundCommandHasCd){
  // 2.1.88 bashPermissions.ts commandHasAnyCd() + pathValidation.ts
  // validateOutputRedirections() ask when a compound cd/pushd/popd can
  // change the working directory used to resolve a relative output target.
  if(compoundCommandHasCd && redirections.length>0){
    return sourceAsk('Compound command contains cd with output redirection - manual approval required to prevent path resolution bypass');
  }
  for(const {target} of redirections){
    // Original source exception. In a Windows shell this path is not the
    // POSIX /dev/null device, so do not grant a device-specific exception.
    if(target==='/dev/null' && process.platform!=='win32')continue;
    const denied=checkOriginalEditScopedRules(target,cwd,context,'deny');
    if(denied.behavior!=='passthrough')return denied;
    const safe=checkOriginalWritePathSafety(target,cwd,context);
    if(safe.behavior!=='passthrough')return {
      behavior:safe.behavior,message:safe.reason,decisionReason:safe.decisionReason,
    };
    const asked=checkOriginalEditScopedRules(target,cwd,context,'ask');
    if(asked.behavior!=='passthrough')return asked;
    // Original BashTool/pathValidation.ts step: treat both > and >>
    // as the 'create' operation (including existing-file truncation).
    // validatePath() runs source isPathAllowed() with the same Edit allow,
    // workspace, source auto-edit safety and acceptEdits ordering.
    const source=validateBashCreatePath(target,cwd,context);
    if(!source.allowed){
      if(source.decisionReason?.type==='rule' &&
         source.decisionReason.rule?.ruleBehavior==='deny')
        return {behavior:'deny',
          message:'Output redirection '+target+' blocked by Edit deny rule',
          decisionReason:source.decisionReason};
      return sourceAsk(source.decisionReason?.reason??
        'Output redirection requires original create-path authorization: '+target);
    }
  }
  return {behavior:'passthrough',message:'No unsafe output redirections found'};
}

export function checkOriginalAstRedirections(commands,cwd,context){
  const redirects=commands.flatMap(command=>command.redirects??[]);
  if(!redirects.length)return {behavior:'passthrough'};
  // Match original bashPermissions.ts commandHasAnyCd()/cdCommands: the
  // cwd-change boundary includes cd, pushd and popd after safe wrappers.
  const hasCd=commands.some(command=>
    ['cd','pushd','popd'].includes(
      stripWrappersFromArgv(command.argv??[])[0]??''));
  const {redirections,hasDangerousRedirection}=astRedirectsToOutputRedirections(redirects);
  if(hasDangerousRedirection)return sourceAsk('Shell expansion syntax in redirection target');
  // Read deny/ask must remain effective even when an unrelated output
  // redirect later needs approval; never conceal a known explicit deny.
  // Source AST helper skips inputs: validate file-backed < separately
  // using the already-ported original validatePath(read) + Read deny/ask.
  for(const redirect of redirects){
    const isInputFile=redirect.op==='<'||
      (redirect.op==='<&'&&!/^(?:\d+|-)$/.test(redirect.target));
    if(isInputFile){
      const target=redirect.target;
      // CLI 2.1.304 H0o() treats standard streams as devices, not workspace
      // files. Preserve these explicit no-file exceptions.
      if(isSafeInputStreamTarget(target))continue;
      const read=validateBashReadPath(target,cwd,context);
      const rule=read.decisionReason?.rule;
      if(!read.allowed&&read.decisionReason?.type==='rule'&&
         rule?.ruleBehavior==='deny'){
        return {behavior:'deny',
          message:'Permission to read Bash input redirection '+target+' has been denied.',
          decisionReason:read.decisionReason};
      }
      // CLI 2.1.304 H0o(): a glob target or a relative target after cd cannot
      // be proven to name the same file that Bash will open. Check explicit
      // Read(path) denials above first, then require approval.
      const globTarget=hasGlobRedirectTarget(target);
      const cwdMayChange=hasCd&&!isAbsolute(target)&&!target.startsWith('~');
      if(globTarget||cwdMayChange){
        const reason='Input redirection target is a glob or follows a cd - manual approval required';
        return {
          behavior:'ask',
          message:`Input redirection from '${target}' requires manual approval: the file it names depends on glob expansion or a directory change in the same command.`,
          blockedPath:target,
          decisionReason:{type:'other',reason,bashMissKind:'shell-expansion'},
        };
      }
      if(!read.allowed){
        return sourceAsk('Bash input redirect path needs read approval: '+target+
          (read.decisionReason?.reason?' ('+read.decisionReason.reason+')':''));
      }
    }
    // Source heredoc and here-string are literals, not filesystem reads.
  }
  // The old checkPathConstraints applies AST-derived file outputs after
  // source semantic validation, before Bash exact permission is consumed.
  const write=validateOutputRedirections(redirections,cwd,context,hasCd);
  if(write.behavior!=='passthrough')return write;
  return {behavior:'passthrough',message:'AST redirection paths validated'};
}

export {astRedirectsToOutputRedirections,validateOutputRedirections};
