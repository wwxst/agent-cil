/**
 * CLI 2.1.304 extracted chunk-jfhbcs0s.js, semantic guard for find/awk.
 * Actual newer argv restrictions transplanted after original CLI 2.1.88
 * parseForSecurity/checkSemantics, before any Bash/mode auto-allow.
 *
 * The 2.1.88 AST's normalized command.text may be rebuilt from argv when
 * tracked variables are resolved. The bridge therefore carries the newer
 * hasUnquotedGlob predicate from the original AST node text before rebuild.
 * The separate argvUnquotedGlob provenance array is now carried by the
 * pinned AST walker and consumed by the 2.1.304 path-validation adapter.
 * Unknown bare expansions remain fail-closed in the old AST.
 */
const FIND_DANGEROUS_ACTIONS=new Set([
  '-exec','-execdir','-ok','-okdir','-delete','-rm',
  '-fprint','-fprint0','-fprintf','-fls','-files0-from',
]);
const FIND_OPTIONS_WITH_OPERAND=new Set([
  '-name','-iname','-path','-ipath','-lname','-ilname','-regex',
  '-iregex','-wholename','-iwholename','-samefile','-newer',
  '-anewer','-cnewer','-mnewer','-perm','-user','-group','-uid',
  '-gid','-size','-type','-xtype','-fstype','-inum','-links',
  '-used','-context','-amin','-cmin','-mmin','-atime','-ctime',
  '-mtime','-mindepth','-maxdepth','-printf','-regextype','-D',
  '-f','-flags','-Bnewer','-Btime','-Bmin','-files0-from','-xattrname',
]);
const FIND_NEWER_OPT_RE=/^-newer[aBcm][aBcmt]$/;
const FIND_OPERAND_FLAG_RE=/^-(?:[EHLPXdsx]*D|f|[dsx]*[EHLPX][EHLPXdsx]*f)$/;
const FIND_AMBIGUOUS_FLAG_RE=/^-[dsx]+f$/;
const AWK_COMMANDS=new Set(['awk','gawk','mawk','nawk']);
const AWK_BAD_FLAG_RE=/^-[bcCghIkMnNOPrsStV]*[fEileDW]/;
const AWK_BAD_LONG_FLAG_RE=/^--(?:fil|e|i|lo|s|de)/;
const XARGS_AWK_OPTION_WITH_OPERAND_RE=/^(?:-[FvW]$|--(?:fie|a$|as))/;
const JQ_DANGEROUS_FLAG_RE=/^(?:-[A-Za-z]*[fL]|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/;

/**
 * CLI 2.1.304 chunk-jfhbcs0s.js function T(e), original quote/comment
 * state transitions. Its SimpleCommand.hasUnquotedGlob is computed from
 * source text; the 2.1.88 AST bridge now carries this source-derived field.
 */
function T(e) {
  let t=false,r=false,s=false,o=true,n=0;
  while(n<e.length) {
    const l=e[n];
    if(s) {
      if(l==='\\'&&(e[n+1]==='\`'||e[n+1]==='\\'||e[n+1]==='$'))n+=2;
      else {if(l==='\`')s=false;n++;}
    }else if(t) {
      if(l==="'")t=false;
      n++;
    }else if(r) {
      if(l==='\\'&&(e[n+1]==='"'||e[n+1]==='\\'||e[n+1]==='\`'))n+=2;
      else if(l==='\`'){s=true;n++;}
      else {if(l==='"')r=false;n++;}
    }else if(l==='\\'&&n+1<e.length) {
      if(e[n+1]!=='\n')o=false;
      n+=2;
    }else if(l==='#'&&o) {
      while(n<e.length&&e[n]!=='\n')n++;
      o=true;
    }else if(l==='\`'){s=true;o=false;n++;}
    else {
      if(l==='*'||l==='?'||l==='[')return true;
      if(l==="'")t=true;
      else if(l==='"')r=true;
      o=l===' '||l==='\t'||l==='\n'||l===';'||l==='|'||
        l==='&'||l==='('||l===')'||l==='<'||l==='>';
      n++;
    }
  }
  return false;
}

// New CLI 2.1.304 uHt() predicates verbatim; no new awk parser.
function checkAwkProgram(arg){
  if(/(?<![A-Za-z_])system[\s\\]*\(/.test(arg))
    return 'awk program contains system() which executes arbitrary commands';
  if(/(?:^|[^|])\|&?[^/|%";#{}]*"/.test(arg)||
     /(?:^|[^|])\|&?[\s\\]*getline\b/.test(arg))
    return 'awk program contains a command pipe (| "cmd" or | getline) which executes arbitrary commands';
  if(/@[\s\\]*(?:load|include)\b|@[\s\\]*\w+(?:::\w+)?(?:\[[^\]]*\])*[\s\\]*\(/.test(arg))
    return 'awk program contains @load/@include or an @indirect call which can execute arbitrary code';
  if(/(?<![A-Za-z_])extension[\s\\]*\(/.test(arg))
    return 'awk program contains extension() which loads arbitrary native code (legacy gawk)';
  if(/"\/inet[46]?\//.test(arg))
    return 'awk program opens a gawk /inet/ network socket which can exfiltrate data';
  return false;
}

// New 2.1.304 find action, option-ambiguity and operand-order checks.
// -rm is checked fail-closed (newer's default-on feature gate).
function checkFindArguments(argv){
  let consumesNext=false;
  for(let i=1;i<argv.length;i++){
    const arg=argv[i],wasOperand=consumesNext;
    consumesNext=false;
    if(FIND_DANGEROUS_ACTIONS.has(arg))
      return "find with '"+arg+"' executes commands or modifies files — cannot be auto-allowed by a Bash(find:*) prefix rule";
    if(FIND_AMBIGUOUS_FLAG_RE.test(arg))
      return "find option '"+arg+"' is read differently by different versions of find — could hide a following action";
    if(!wasOperand&&FIND_OPERAND_FLAG_RE.test(arg)){
      consumesNext=true;continue;
    }
    if(!wasOperand&&(FIND_OPTIONS_WITH_OPERAND.has(arg)||FIND_NEWER_OPT_RE.test(arg))){
      i++;continue;
    }
    if(arg.includes('__CMDSUB_OUTPUT__')||arg.includes('__TRACKED_VAR__'))
      return 'find argument is runtime-determined — could resolve to a dangerous action';
    // 2.1.304 per-argv glob fallback (after source option/operand scan).
    if(/[[\]*?]/.test(arg))
      return "find argument '"+arg+"' contains glob characters — could glob-expand to a dangerous action";
  }
  return null;
}
function normalizeNewerBashSafetyWrappers(argv){
  let checkedArgv=argv;
  let xargsWrapped=false;
  for(;;){
    const wrapper=checkedArgv[0]?.replace(/^.*[\\/]/,'');
    if(wrapper==='command'){
      let i=1,query=false;
      while(i<checkedArgv.length&&checkedArgv[i].startsWith('-')&&
          checkedArgv[i]!=='--'){
        const arg=checkedArgv[i];
        if(!/^-[pvV]+$/.test(arg))
          return {error:'command wrapper has an unrecognized flag and cannot be statically analyzed'};
        if(arg.includes('v')||arg.includes('V'))query=true;
        i++;
      }
      if(checkedArgv[i]==='--')i++;
      if(query||i>=checkedArgv.length)break;
      checkedArgv=checkedArgv.slice(i);
    }else if(wrapper==='builtin'||wrapper==='noglob'){
      const i=wrapper==='builtin'&&checkedArgv[1]==='--'?2:1;
      if(i<checkedArgv.length)checkedArgv=checkedArgv.slice(i);
      else break;
    }else if(wrapper==='xargs'){
      // CLI 2.1.304 unwraps xargs when its executable is statically visible
      // as argv[1]. If flags or no command precede it, the adapter cannot
      // prove which program receives stdin-derived arguments: ask.
      if(checkedArgv.length<2||checkedArgv[1].startsWith('-'))
        return {error:'xargs flags or missing command prevent static verification of the executed program'};
      checkedArgv=checkedArgv.slice(1);
      xargsWrapped=true;
    }else break;
  }
  return {argv:checkedArgv,xargsWrapped};
}

const NEWER_ZSH_SAFE_SET_OPTIONS=new Set([
  'pipefail','errexit','nounset','xtrace','noglob','noclobber','verbose',
  'monitor','notify','vi','emacs','errtrace','functrace','hashall','physical',
  'ignoreeof',
]);
const NEWER_SET_SAFE_LETTERS=new Set(['e','u','x','f','C','v','m','b','E','T','h','P','n']);
const NEWER_TEST_ARITH_OPS=new Set(['-eq','-ne','-lt','-le','-gt','-ge']);
const NEWER_ARITH_LITERAL_RE=/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[0-9]+)$/;
const NEWER_COMMAND_LAUNCHERS=new Set([
  'watch','ionice','chrt','setsid','taskset','strace','ltrace','script',
  'flock','unshare','nsenter',
]);
const NEWER_ZSH_DANGEROUS_BUILTINS=new Set([
  'zmodload','emulate','sysopen','sysread','syswrite','sysseek','zpty','ztcp',
  'zsocket','zf_rm','zf_mv','zf_ln','zf_chmod','zf_chown','zf_mkdir',
  'zf_rmdir','zf_chgrp','repeat','foreach','zcompile','setopt','unsetopt',
  'disable','shopt','autoload','functions',
]);
const NEWER_ZSH_SEMANTIC_BUILTINS=new Set([
  'declare','typeset','local','export','readonly','private','float','integer',
  'print','getopts','set','zparseopts','zformat','zstyle','shift','exit',
  'return','break','continue','bye','logout','vared','getln','zregexparse',
]);
const NEWER_ZSH_TYPED_BUILTINS=new Set([
  'declare','typeset','local','export','readonly','private','float','integer',
]);
const NEWER_ZSH_DECLARATION_FLAG_RE=/^[-+].*[nialuAEFLRZ]/;
const NEWER_ZSH_TYPED_FLAG_RE=/^[+-].*[iluEFLRZ]/;
function hasRuntimeDeterminedArgument(arg){
  return arg.includes('__CMDSUB_OUTPUT__')||arg.includes('__TRACKED_VAR__');
}
function checkNewerZshSemanticHazards(argv){
  const name=argv[0];
  if(!name)return null;
  if(NEWER_ZSH_DANGEROUS_BUILTINS.has(name)){
    return "Zsh builtin '"+name+"' can bypass security checks";
  }
  if(NEWER_ZSH_SEMANTIC_BUILTINS.has(name)){
    const isDeclaration=name==='declare'||name==='typeset'||name==='local';
    const hasPatternAssignment=isDeclaration||name==='export'||name==='readonly'||name==='private';
    const tracksFunction=isDeclaration||name==='readonly';
    let hasFunctionFlag=false,hasAutoloadFlag=false;
    for(const arg of argv.slice(1)){
      if(tracksFunction){
        if(/^[+-].*f/.test(arg))hasFunctionFlag=true;
        if(/^[+-].*[uU]/.test(arg))hasAutoloadFlag=true;
        if(hasFunctionFlag&&hasAutoloadFlag)
          return "'"+name+"' with both -f and -u/-U flags — zsh marks a function for autoload at call time";
      }
      if(isDeclaration&&NEWER_ZSH_DECLARATION_FLAG_RE.test(arg))
        return "'"+name+"' flag "+arg+" changes assignment semantics (nameref/integer/array/width-truncation/case-conversion)";
      if(NEWER_ZSH_TYPED_BUILTINS.has(name)&&NEWER_ZSH_TYPED_FLAG_RE.test(arg))
        return "'"+name+"' flag "+arg+" changes zsh assignment/type semantics";
      if(hasPatternAssignment&&/^[+-].*m/.test(arg))
        return "'"+name+"' with -m/+m flag pattern-assigns matching variables";
      if(NEWER_ZSH_TYPED_BUILTINS.has(name)&&/^[+-].*T/.test(arg))
        return "'"+name+" -T' creates a zsh tied pair — tracked literals for its operands are unreliable";
      if((arg.includes('[')&&(arg.includes('$')||arg.includes(String.fromCharCode(96))))||
          hasRuntimeDeterminedArgument(arg))
        return "'"+name+"' operand is runtime-determined or contains an expanded subscript";
      if((name==='float'||name==='integer')&&!/^[-+]/.test(arg))
        return "zsh '"+name+"' operand implicitly evaluates an arithmetic expression";
    }
  }
  if(name==='test'||name==='['||name==='[['){
    for(let i=1;i<argv.length;i++){
      const flag=argv[i],operand=argv[i+1];
      if((flag==='-v'||flag==='-R'||flag==='-t')&&operand!==undefined&&
          (operand.includes('[')||hasRuntimeDeterminedArgument(operand))){
        return "'"+name+" "+flag+"' operand contains array subscript or runtime-determined value — shell evaluates $(cmd) in subscripts";
      }
      if(flag==='-t'&&operand!==undefined&&!NEWER_ARITH_LITERAL_RE.test(operand)){
        return "'"+name+" -t' operand is non-numeric — zsh arith-evals identifiers (may run $(cmd))";
      }
    }
    for(let i=2;i<argv.length;i++){
      if(!NEWER_TEST_ARITH_OPS.has(argv[i]))continue;
      for(const operand of [argv[i-1],argv[i+1]]){
        if(operand===undefined)continue;
        if(operand.includes('[')||!NEWER_ARITH_LITERAL_RE.test(operand)){
          return "'"+name+" ... "+argv[i]+" ...' operand is non-numeric — zsh arithmetically evaluates identifiers/subscripts (may run $(cmd))";
        }
      }
    }
  }
  if(name==='printf'){
    for(const arg of argv.slice(1)){
      if((arg.includes('[')&&(arg.includes('$')||arg.includes(String.fromCharCode(96))))||
          hasRuntimeDeterminedArgument(arg)){
        return "printf operand '"+arg+"' contains a subscript or runtime-determined value — zsh arith-evals %d/%i operands (may run $(cmd))";
      }
    }
  }
  if(name==='set'){
    for(let i=1;i<argv.length;i++){
      const arg=argv[i];
      if(arg==='--')break;
      if(!/^[-+]/.test(arg))continue;
      for(let j=1;j<arg.length;j++){
        const flag=arg[j];
        if(flag==='o'){
          const option=j<arg.length-1?arg.slice(j+1):argv[i+1];
          if(option!==undefined&&option!==''&&
              !NEWER_ZSH_SAFE_SET_OPTIONS.has(option.toLowerCase().replace(/[_-]/g,''))){
            return "'set -o/+o "+option+"' changes shell parsing/globbing state — can enable globsubst/extendedglob and defeat static analysis";
          }
          if(j===arg.length-1)i++;
          break;
        }
        if(flag==='A')break;
        if(!NEWER_SET_SAFE_LETTERS.has(flag)){
          return "'set "+arg[0]+flag+"' changes shell option state — defeats static env-var analysis";
        }
      }
    }
  }
  if(name==='print'&&argv.some(arg=>/^[+-].*P/.test(arg))){
    for(const arg of argv.slice(1)){
      if(arg.includes('$(')||arg.includes(String.fromCharCode(96))||
          hasRuntimeDeterminedArgument(arg)){
        return "'print -P' operand contains command substitution — zsh prompt expansion evaluates $(cmd)";
      }
    }
  }
  if(name==='jobs'&&argv.slice(1).some(arg=>/^[+-].*x/.test(arg))){
    return "What 'jobs -x' starts can't be checked before it runs";
  }
  if(NEWER_COMMAND_LAUNCHERS.has(name)&&argv.length>1){
    return "What '"+name+"' starts can't be checked before it runs";
  }
  return null;
}

export function checkNewerBashFindAwkSemantics(argv,command={}){
  if(!Array.isArray(argv)||argv.length===0)return {behavior:'passthrough'};
  const normalized=normalizeNewerBashSafetyWrappers(argv);
  if(normalized.error)
    return {behavior:'ask',message:normalized.error};
  const checkedArgv=normalized.argv;
  const xargsWrapped=normalized.xargsWrapped;
  const base=checkedArgv[0];
  const zshHazard=checkNewerZshSemanticHazards(checkedArgv);
  if(zshHazard)return {behavior:'ask',message:zshHazard};
  const unquotedGlob=command.hasUnquotedGlob===true||
    (typeof command.text==='string'&&T(command.text));
  // New CLI 2.1.304 xargs wrapper gate: stdin-derived arguments can become
  // find expressions or jq flags/program input even when the static argv is
  // harmless. Never infer those additions are safe.
  if(xargsWrapped&&(base==='find'||base==='jq'))
    return {behavior:'ask',message:"What xargs adds to "+base+" can't be checked before it runs"};
  // CLI 2.1.304 jq guard, including commands reached through wrappers
  // such as `command jq`. The pinned 2.1.88 semantic walker does not unwrap
  // every newer wrapper, so these checks must run on the normalized argv.
  if(base==='jq'){
    for(const arg of checkedArgv){
      if(/\bsystem\s*\(/.test(arg))
        return {behavior:'ask',message:'jq command contains system() function which executes arbitrary commands'};
      if(/\b(?:include|import)\b/.test(arg))
        return {behavior:'ask',message:'jq command contains include/import — modules can load arbitrary .jq files via {search:"."} and call env or other builtins'};
    }
    if(checkedArgv.some(arg=>JQ_DANGEROUS_FLAG_RE.test(arg)))
      return {behavior:'ask',message:'jq command contains dangerous flags that could execute code or read arbitrary files'};
  }
  if(xargsWrapped&&AWK_COMMANDS.has(base)){
    let hasProgram=false;
    for(let i=1;i<checkedArgv.length;i++){
      const arg=checkedArgv[i];
      if(arg==='--'){hasProgram=i+1<checkedArgv.length;break;}
      if(arg==='-'||!arg.startsWith('-')){hasProgram=true;break;}
      if(!arg.includes('=')&&XARGS_AWK_OPTION_WITH_OPERAND_RE.test(arg))i++;
    }
    if(!hasProgram)
      return {behavior:'ask',message:"The program xargs gives awk can't be checked before it runs"};
  }
  if(AWK_COMMANDS.has(base)){
    if(unquotedGlob)
      return {behavior:'ask',message:'awk command contains unquoted glob characters — could glob-expand to a planted program or flag before awk runs'};
    for(const arg of checkedArgv){
      const reason=checkAwkProgram(arg);
      if(reason!==false)return {behavior:'ask',message:reason};
      if(arg.includes('__CMDSUB_OUTPUT__')||arg.includes('__TRACKED_VAR__'))
        return {behavior:'ask',message:'awk is given text that cannot be checked before it runs'};
    }
    if(checkedArgv.some(arg=>AWK_BAD_FLAG_RE.test(arg)||AWK_BAD_LONG_FLAG_RE.test(arg)))
      return {behavior:'ask',message:'awk has an option that cannot be checked before it runs'};
  }
  if(base==='find'){
    if(unquotedGlob)
      return {behavior:'ask',message:'find contains unquoted glob characters — could glob-expand to a dangerous action before find runs'};
    const reason=checkFindArguments(checkedArgv);
    if(reason)return {behavior:'ask',message:reason};
  }
  return {behavior:'passthrough'};
}
export {checkAwkProgram,checkFindArguments,T};
