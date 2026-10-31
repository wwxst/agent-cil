/**
 * Original CLI 2.1.88 BashTool/pathValidation.ts: ACTION_VERBS,
 * validateCommandPaths(), createPathChecker(); original src/utils/path.ts:
 * getDirectoryForPath(); PermissionUpdate.ts:createReadRuleSuggestion().
 * Only TS type erasure and CLI dependency bindings are changed.
 *
 * This file replaces the earlier home-built PATH_EXTRACTORS/validation
 * loop in the real Bash AST execution gate. Full original startup sandbox
 * and internal-path grant sources remain intentionally unconnected.
 */
import {dirname,isAbsolute,posix} from 'node:path';
import {homedir} from 'node:os';
import {statSync} from 'node:fs';
import {PATH_EXTRACTORS,COMMAND_VALIDATOR,COMMAND_OPERATION_TYPE} from './generated/originalPathExtractors.js';

// CLI 2.1.304 chunk-4b60tdnk.js: exact positional-operand scan used by ep().
function extractNewerPositionalPaths(args) {
  const paths=[];
  let afterDoubleDash=false,afterFirstPath=false;
  for(const arg of args) {
    if(arg===undefined||arg===null)continue;
    if(afterDoubleDash||afterFirstPath)paths.push(arg);
    else if(arg==='--')afterDoubleDash=true;
    else if(arg==='-'||!arg.startsWith('-')) {
      paths.push(arg);
      afterFirstPath=true;
    }
  }
  return paths;
}
const TEE_STREAM_TARGETS=new Set(['/dev/null','/dev/stdout','/dev/stderr','/dev/tty']);
function extractTeePaths(args) {
  return extractNewerPositionalPaths(args).filter(path=>!TEE_STREAM_TARGETS.has(path));
}

// CLI 2.1.304 Ov(): option-aware positional path extraction.
function createNewerOptionPathExtractor({
  booleanShort='',attachedShort='',valuedShort='',
  booleanLong=new Set(),attachedLong=new Set(),valuedLong=new Set(),
}) {
  function classify(option) {
    if(option.startsWith('--')) {
      if(option.includes('='))return 'attached';
      if(booleanLong.has(option))return 'boolean';
      if(attachedLong.has(option))return 'attached';
      return valuedLong.has(option)?'valued':'unknown';
    }
    if(/^-\\d+$/.test(option))return 'attached';
    for(let i=1;i<option.length;i++) {
      const ch=option[i];
      if(booleanShort.includes(ch))continue;
      if(attachedShort.includes(ch))return 'attached';
      if(!valuedShort.includes(ch))return 'unknown';
      return i===option.length-1?'valued':'attached';
    }
    return 'boolean';
  }
  return args=>{
    const paths=[];
    let afterDoubleDash=false,afterFirstPath=false,canParseFlags=true;
    for(let i=0;i<args.length;i++) {
      const arg=args[i];
      if(arg===undefined||arg===null)continue;
      if(afterDoubleDash||afterFirstPath)paths.push(arg);
      else if(arg==='--')afterDoubleDash=true;
      else if(arg!=='-'&&arg.startsWith('-')) {
        if(!canParseFlags)continue;
        const kind=classify(arg);
        if(kind==='valued')i++;
        else if(kind==='unknown')canParseFlags=false;
      } else {
        paths.push(arg);
        afterFirstPath=true;
      }
    }
    return paths;
  };
}
function getAttachedOptionValue(arg,options) {
  if(typeof arg!=='string'||!arg.startsWith('-'))return undefined;
  const equal=arg.indexOf('=');
  if(equal>=0) {
    if(options.includes(arg.slice(0,equal)))return arg.slice(equal+1);
    return undefined;
  }
  for(const option of options) {
    if(option.length===2&&option[0]==='-'&&arg.startsWith(option)&&arg!==option)
      return arg.slice(option.length);
  }
  return undefined;
}

// CLI 2.1.304 aze()/oze(): grep/rg paths and pattern-file operands.
function extractNewerPatternPaths(args,flagsWithArgs,defaults=[]) {
  const paths=[];
  let patternFound=false,afterDoubleDash=false,firstPositionalSeen=false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg===undefined||arg===null)continue;
    if(!afterDoubleDash&&!firstPositionalSeen&&arg==='--') {
      afterDoubleDash=true;
      continue;
    }
    if(!afterDoubleDash&&!firstPositionalSeen&&arg!=='-'&&arg.startsWith('-')) {
      const equal=arg.indexOf('=');
      const flag=equal>=0?arg.slice(0,equal):arg;
      if(['-e','--regexp','-f','--file'].includes(flag)) {
        patternFound=true;
        if(flag==='-f'||flag==='--file') {
          const value=equal>=0?arg.slice(equal+1):args[i+1];
          if(value)paths.push(value);
        }
      }
      if(/^-[a-zA-Z]*f$/.test(flag)&&flag!=='-f'&&equal<0&&args[i+1]!==undefined) {
        patternFound=true;
        paths.push(args[i+1]);
        i++;
        continue;
      }
      if(['--exclude-from','--include-from','--ignore-file'].includes(flag)) {
        const value=equal>=0?arg.slice(equal+1):args[i+1];
        if(value)paths.push(value);
        if(equal<0)i++;
        continue;
      }
      if(equal<0) {
        const attached=getAttachedOptionValue(arg,['-f','--file']);
        if(attached!==undefined) {
          patternFound=true;
          paths.push(attached);
          continue;
        }
        if(arg.length>2&&arg.startsWith('-e')) {
          patternFound=true;
          continue;
        }
      }
      if(flagsWithArgs.has(flag)&&equal<0)i++;
      continue;
    }
    if(firstPositionalSeen&&!afterDoubleDash) {
      const attached=getAttachedOptionValue(arg,['-f','--file']);
      if(attached!==undefined)paths.push(attached);
    }
    firstPositionalSeen=true;
    if(!patternFound) {
      patternFound=true;
      continue;
    }
    paths.push(arg);
  }
  return paths.length>0?paths:defaults;
}
const GREP_PATH_FLAGS=new Set([
  '-e','--regexp','-f','--file','--exclude','--include','--exclude-dir',
  '--include-dir','-m','--max-count','-A','--after-context','-B',
  '--before-context','-C','--context',
]);
function extractNewerGrepPaths(args) {
  const paths=extractNewerPatternPaths(args,GREP_PATH_FLAGS);
  if(paths.length===0&&args.some(arg=>['-r','-R','--recursive'].includes(arg)))
    return ['.'];
  return paths;
}
const RG_PATH_FLAGS=new Set([
  '-e','--regexp','-f','--file','-t','--type','-T','--type-not','-g',
  '--glob','-m','--max-count','--max-depth','-r','--replace','-A',
  '--after-context','-B','--before-context','-C','--context',
]);
function extractNewerRgPaths(args) {
  return extractNewerPatternPaths(args,RG_PATH_FLAGS,['.']);
}

// CLI 2.1.304 Ome(): awk/gawk/mawk/nawk program and file operands.
function extractNewerAwkPaths(args) {
  const paths=[];
  const valueFlags=new Set(['-F','--field-separator','-v','--assign','-e','--source']);
  const fileFlags=['-f','--file','-E','--exec'];
  const fileFlagSet=new Set(fileFlags);
  let afterDoubleDash=false,firstPositionalSeen=false,programFound=false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg===undefined||arg===null)continue;
    if(!afterDoubleDash&&!firstPositionalSeen&&arg==='--') {
      afterDoubleDash=true;
      continue;
    }
    if(!afterDoubleDash&&!firstPositionalSeen&&arg!=='-'&&arg.startsWith('-')) {
      const equal=arg.indexOf('=');
      const flag=equal>=0?arg.slice(0,equal):arg;
      if(valueFlags.has(flag)) {
        if(flag==='-e'||flag==='--source')programFound=true;
        if(equal<0)i++;
        continue;
      }
      if(fileFlagSet.has(flag)) {
        programFound=true;
        if(equal>=0)paths.push(arg.slice(equal+1));
        else if(args[i+1]!==undefined) {
          paths.push(args[i+1]);
          i++;
        }
        continue;
      }
      continue;
    }
    if(firstPositionalSeen&&!afterDoubleDash) {
      const attached=getAttachedOptionValue(arg,fileFlags);
      if(attached!==undefined)paths.push(attached);
    }
    firstPositionalSeen=true;
    if(!programFound) {
      programFound=true;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}

function extractNewerFindPaths(args) {
  const paths=[];
  const pathFlags=new Set([
    '-newer','-anewer','-cnewer','-mnewer','-samefile','-path',
    '-wholename','-ilname','-lname','-ipath','-iwholename',
  ]);
  const newerPattern=/^-newer[acmBt][acmtB]$/;
  let foundNonGlobalFlag=false,afterDoubleDash=false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(!arg)continue;
    if(afterDoubleDash) {
      paths.push(arg);
      continue;
    }
    if(arg==='--') {
      afterDoubleDash=true;
      continue;
    }
    if(arg.startsWith('-')) {
      if(['-H','-L','-P'].includes(arg))continue;
      foundNonGlobalFlag=true;
      if(pathFlags.has(arg)||newerPattern.test(arg)) {
        const value=args[i+1];
        if(value) {
          paths.push(value);
          i++;
        }
      }
      continue;
    }
    if(!foundNonGlobalFlag)paths.push(arg);
  }
  return paths.length>0?paths:['.'];
}
function extractNewerSedPaths(args) {
  const paths=[];
  let skipNext=false,scriptFound=false,afterDoubleDash=false,firstPathSeen=false;
  for(let i=0;i<args.length;i++) {
    if(skipNext) {
      skipNext=false;
      continue;
    }
    const arg=args[i];
    if(!arg)continue;
    if(!afterDoubleDash&&!firstPathSeen&&arg==='--') {
      afterDoubleDash=true;
      continue;
    }
    if(!afterDoubleDash&&!firstPathSeen&&arg!=='-'&&arg.startsWith('-')) {
      if(['-f','--file'].includes(arg)) {
        const scriptFile=args[i+1];
        if(scriptFile) {
          paths.push(scriptFile);
          skipNext=true;
        }
        scriptFound=true;
      } else if(['-e','--expression'].includes(arg)) {
        skipNext=true;
        scriptFound=true;
      } else if(arg.includes('e')||arg.includes('f')) {
        scriptFound=true;
      }
      continue;
    }
    firstPathSeen=true;
    if(!scriptFound) {
      scriptFound=true;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}
function extractNewerJqPaths(args) {
  const paths=[];
  const flagsWithArgs=new Set([
    '-e','--expression','--arg','--argjson','--args','--jsonargs','-L',
    '--library-path','--indent','--tab',
  ]);
  let filterFound=false,afterDoubleDash=false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg===undefined||arg===null)continue;
    if(!afterDoubleDash&&arg==='--') {
      afterDoubleDash=true;
      continue;
    }
    if(!afterDoubleDash&&arg.startsWith('-')) {
      const equal=arg.indexOf('=');
      const flag=equal>=0?arg.slice(0,equal):arg;
      if(['-e','--expression'].includes(flag))filterFound=true;
      if(['-f','--from-file'].includes(flag)) {
        filterFound=true;
        if(equal>=0)paths.push(arg.slice(equal+1));
        else {
          const value=args[i+1];
          if(value!==undefined)paths.push(value);
          i++;
        }
        continue;
      }
      if(['--slurpfile','--rawfile'].includes(flag)) {
        const value=args[i+2];
        if(value!==undefined)paths.push(value);
        i+=2;
        continue;
      }
      if(flagsWithArgs.has(flag)&&equal<0)i++;
      continue;
    }
    if(!filterFound) {
      filterFound=true;
      continue;
    }
    paths.push(arg);
  }
  return paths;
}
function isNewerGitSpecialPath(path) {
  return path==='/dev/null'||path==='/dev/stdin'||path==='/dev/stdout'||
    path==='/dev/stderr'||path==='/dev/tty'||/^\/dev\/fd\/\d+$/.test(path)||
    /^\/proc\/self\/fd\/[0-2]$/.test(path);
}
function joinNewerGitPath(prefix,path) {
  return prefix===''?path:prefix.replace(/\/+$/,'')+'/'+path;
}
function extractNewerGitPaths(args) {
  let prefix='';
  const setPrefix=path=>{
    prefix=isAbsolute(path)||path.startsWith('~')
      ?path:joinNewerGitPath(prefix,path);
  };
  const {index,options}=parseGitGlobalOptions(args);
  for(const {opt,value} of options) {
    if(opt.startsWith('--work-tree='))setPrefix(opt.slice(12));
    else if(value!==undefined&&(opt==='-C'||opt==='--work-tree'))setPrefix(value);
  }
  const resolveGitPath=path=>
    prefix===''||isAbsolute(path)||path.startsWith('~')
      ?path:joinNewerGitPath(prefix,path);
  const subcommand=args[index];
  const rest=args.slice(index+1);
  if(subcommand==='grep') {
    const paths=extractNewerPatternPaths(rest,new Set([
      '-e','--regexp','-f','--file','-A','--after-context','-B',
      '--before-context','-C','--context','-m','--max-count','--max-depth',
      '--threads',
    ]));
    return paths.length>0?paths.map(resolveGitPath):[prefix===''?'.':prefix];
  }
  if(subcommand!=='diff')return [];
  const paths=[];
  let afterDoubleDash=false;
  for(const arg of rest) {
    if(!afterDoubleDash&&arg==='--') {
      afterDoubleDash=true;
      continue;
    }
    if(afterDoubleDash||arg==='-'||!arg.startsWith('-')) {
      const resolved=resolveGitPath(arg);
      if(!isNewerGitSpecialPath(resolved))paths.push(resolved);
    }
  }
  return paths;
}
function extractNewerManPaths(args) {
  const localFileMode=args.some(arg=>arg==='--local-file'||(/^-[^-]/.test(arg)&&arg.includes('l')));
  const paths=[];
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(i>0&&(args[i-1]==='-C'||args[i-1]==='--config-file')) {
      paths.push(arg);
      continue;
    }
    const pathIndex=arg.search(/[\\\\/~]/);
    const candidates=arg.startsWith('-')
      ?[
        ...(arg.includes('=')?[arg.slice(arg.indexOf('=')+1)]:[]),
        ...(arg.length>2&&!arg.startsWith('--')?[arg.slice(2)]:[]),
        ...(pathIndex>0?[arg.slice(pathIndex)]:[]),
      ]
      :[arg];
    for(const candidate of new Set(candidates)) {
      if(candidate!==''&&(localFileMode||/[\\\\/]/.test(candidate)||
        candidate.startsWith('~')||candidate.startsWith('.')))
        paths.push(candidate);
    }
  }
  return paths;
}
const NEWER_PATH_EXTRACTORS=Object.freeze({
  cd:args=>{
    const paths=extractNewerPositionalPaths(args);
    if(paths.length===0)return args[args.length-1]==='-'?['-']:[homedir()];
    return [paths[0]];
  },
  ls:args=>{
    const paths=extractNewerPositionalPaths(args);
    return paths.length>0?paths:['.'];
  },
  find:extractNewerFindPaths,
  mkdir:extractNewerPositionalPaths,touch:extractNewerPositionalPaths,
  rm:extractNewerPositionalPaths,rmdir:extractNewerPositionalPaths,
  mv:extractNewerPositionalPaths,cp:extractNewerPositionalPaths,
  cat:extractNewerPositionalPaths,head:extractNewerPositionalPaths,
  tail:extractNewerPositionalPaths,sort:extractNewerPositionalPaths,
  uniq:extractNewerPositionalPaths,wc:extractNewerPositionalPaths,
  cut:createNewerOptionPathExtractor({
    booleanShort:'nswz',valuedShort:'bcdf',
    booleanLong:new Set(['--complement','--only-delimited','--zero-terminated']),
    valuedLong:new Set(['--bytes','--characters','--delimiter','--fields','--output-delimiter']),
  }),
  paste:createNewerOptionPathExtractor({
    booleanShort:'sz',valuedShort:'d',
    booleanLong:new Set(['--serial','--zero-terminated']),
    valuedLong:new Set(['--delimiters']),
  }),
  column:createNewerOptionPathExtractor({
    booleanShort:'txdemLJhV',valuedShort:'cosNOClEHRTWrip',
    booleanLong:new Set(['--table','--fillrows','--table-noheadings',
      '--table-header-repeat','--table-maxout','--keep-empty-lines','--json']),
    valuedLong:new Set(['--separator','--output-separator','--output-width',
      '--table-name','--table-order','--table-column','--table-columns',
      '--table-columns-limit','--table-noextreme','--table-hide','--table-right',
      '--table-truncate','--table-wrap','--tree','--tree-id','--tree-parent']),
  }),
  file:extractNewerPositionalPaths,stat:extractNewerPositionalPaths,
  diff:extractNewerPositionalPaths,
  awk:extractNewerAwkPaths,gawk:extractNewerAwkPaths,
  mawk:extractNewerAwkPaths,nawk:extractNewerAwkPaths,
  strings:extractNewerPositionalPaths,hexdump:extractNewerPositionalPaths,
  od:extractNewerPositionalPaths,base64:extractNewerPositionalPaths,
  nl:extractNewerPositionalPaths,sha256sum:extractNewerPositionalPaths,
  sha1sum:extractNewerPositionalPaths,md5sum:extractNewerPositionalPaths,
  tee:extractTeePaths,
  tr:args=>{
    const hasDelete=args.some(arg=>arg==='-d'||arg==='--delete'||
      arg.startsWith('-')&&arg.includes('d'));
    return extractNewerPositionalPaths(args).slice(hasDelete?1:2);
  },
  grep:extractNewerGrepPaths,egrep:extractNewerGrepPaths,
  fgrep:extractNewerGrepPaths,
  tac:createNewerOptionPathExtractor({
    booleanShort:'br',valuedShort:'s',
    booleanLong:new Set(['--before','--regex']),
    valuedLong:new Set(['--separator']),
  }),
  rev:extractNewerPositionalPaths,
  fold:createNewerOptionPathExtractor({
    booleanShort:'bs',valuedShort:'w',
    booleanLong:new Set(['--bytes','--spaces']),
    valuedLong:new Set(['--width']),
  }),
  expand:createNewerOptionPathExtractor({
    booleanShort:'i',valuedShort:'t',
    booleanLong:new Set(['--initial']),
    valuedLong:new Set(['--tabs']),
  }),
  unexpand:createNewerOptionPathExtractor({
    booleanShort:'af',valuedShort:'t',
    booleanLong:new Set(['--all','--first-only']),
    valuedLong:new Set(['--tabs']),
  }),
  fmt:createNewerOptionPathExtractor({
    booleanShort:'csumn',valuedShort:'wgdl',
    booleanLong:new Set(['--crown-margin','--split-only','--tagged-paragraph',
      '--uniform-spacing']),
    valuedLong:new Set(['--width','--goal','--prefix']),
  }),
  comm:createNewerOptionPathExtractor({
    booleanShort:'123iz',valuedShort:'',
    booleanLong:new Set(['--check-order','--nocheck-order','--total',
      '--zero-terminated']),
    valuedLong:new Set(['--output-delimiter']),
  }),
  cmp:createNewerOptionPathExtractor({
    booleanShort:'blsvxzh',valuedShort:'',
    booleanLong:new Set(['--print-bytes','--verbose','--quiet','--silent']),
    valuedLong:new Set(['--ignore-initial','--bytes']),
  }),
  pr:createNewerOptionPathExtractor({
    booleanShort:'acdFfJmprtTv',attachedShort:'einsS',valuedShort:'hlwWoND',
    booleanLong:new Set(['--across','--show-control-chars','--double-space',
      '--form-feed','--join-lines','--merge','--no-file-warnings',
      '--omit-header','--omit-pagination','--show-nonprinting']),
    attachedLong:new Set(['--expand-tabs','--output-tabs','--number-lines',
      '--separator','--sep-string']),
    valuedLong:new Set(['--header','--length','--width','--page-width',
      '--indent','--first-line-number','--date-format','--columns']),
  }),
  numfmt:createNewerOptionPathExtractor({
    booleanShort:'z',valuedShort:'d',
    booleanLong:new Set(['--grouping','--zero-terminated','--debug']),
    attachedLong:new Set(['--header']),
    valuedLong:new Set(['--from','--to','--from-unit','--to-unit','--format',
      '--padding','--delimiter','--field','--round','--suffix','--invalid']),
  }),
  tsort:extractNewerPositionalPaths,man:extractNewerManPaths,
  rg:extractNewerRgPaths,sed:extractNewerSedPaths,jq:extractNewerJqPaths,
  git:extractNewerGitPaths,
});
const NEWER_COMMAND_OPERATION_TYPE=Object.freeze({
  cd:'read',ls:'read',find:'read',mkdir:'create',touch:'create',rm:'write',
  rmdir:'write',mv:'write',cp:'write',cat:'read',head:'read',tail:'read',
  sort:'read',uniq:'read',wc:'read',cut:'read',paste:'read',column:'read',
  file:'read',stat:'read',diff:'read',awk:'read',gawk:'read',mawk:'read',
  nawk:'read',strings:'read',hexdump:'read',od:'read',base64:'read',nl:'read',
  sha256sum:'read',sha1sum:'read',md5sum:'read',tee:'write',tr:'read',
  grep:'read',egrep:'read',fgrep:'read',tac:'read',rev:'read',fold:'read',
  expand:'read',unexpand:'read',fmt:'read',comm:'read',cmp:'read',pr:'read',
  numfmt:'read',tsort:'read',man:'read',rg:'read',sed:'write',jq:'read',
  git:'read',
});
// CLI 2.1.304 chunk-4b60tdnk.js k0o: cp/mv reject flags; cd permits at
// most one positional directory after leading options and an optional --.
const NEWER_COMMAND_VALIDATOR=Object.freeze({
  mv:args=>!args.some(arg=>arg?.startsWith('-')),
  cp:args=>!args.some(arg=>arg?.startsWith('-')),
  cd:args=>{
    let positionalSeen=false,count=0;
    for(const arg of args) {
      if(!positionalSeen) {
        if(arg==='--') {
          positionalSeen=true;
          continue;
        }
        if(arg?.startsWith('-')&&arg!=='-')continue;
        positionalSeen=true;
      }
      count++;
    }
    return count<=1;
  },
});
export function getOriginalBashPathExtractor(command) {
  return NEWER_PATH_EXTRACTORS[command]??PATH_EXTRACTORS[command];
}
export function isOriginalBashPathCommand(command) {
  return typeof getOriginalBashPathExtractor(command)==='function';
}
export function getOriginalBashPathOperationType(command) {
  return NEWER_COMMAND_OPERATION_TYPE[command]??COMMAND_OPERATION_TYPE[command];
}
import {checkDangerousRemovalPaths} from './bash-original-dangerous-path.js';
import {
  validateBashReadPath,validateBashCreatePath,checkOriginalEditScopedRules,
  hasOriginalReadDenyRules,expandOriginalPath,windowsPathToPosixPath,
  allWorkingDirectories,formatDirectoryList
} from './original-bash-read-paths.js';
const toPosixPath=(path)=>process.platform==='win32'?windowsPathToPosixPath(path):path;
const expandPath=(path)=>expandOriginalPath(path);
const getFsImplementation=()=>({statSync});
// Original validatePath() is retained in original-bash-read-paths.js.
// All non-read operations reenter its source validatePath(create), not a
// synthetic workspace-allow boolean. Scoped Edit ask is independently
// enforced because source isPathAllowed() handles deny/allow but not ask.
function validatePath(path,cwd,toolPermissionContext,operationType){
  if(operationType==='read'){
    const read=validateBashReadPath(path,cwd,toolPermissionContext);
    if(!read.allowed && read.decisionReason?.type==='rule' &&
       read.decisionReason.rule?.ruleBehavior==='ask')
      return {...read,decisionReason:{type:'other',reason:'Scoped Read(path) requires approval'}};
    return read;
  }
  const denied=checkOriginalEditScopedRules(path,cwd,toolPermissionContext,'deny');
  if(denied.behavior==='deny')
    return {allowed:false,resolvedPath:path,decisionReason:denied.decisionReason};
  if(denied.behavior!=='passthrough')
    return {allowed:false,resolvedPath:path,decisionReason:{type:'other',reason:denied.message}};
  const asked=checkOriginalEditScopedRules(path,cwd,toolPermissionContext,'ask');
  if(asked.behavior!=='passthrough')
    return {allowed:false,resolvedPath:path,decisionReason:{type:'other',reason:asked.message}};
  return validateBashCreatePath(path,cwd,toolPermissionContext);
}
const ACTION_VERBS = {
  cd: 'change directories to',
  ls: 'list files in',
  find: 'search files in',
  mkdir: 'create directories in',
  touch: 'create or modify files in',
  rm: 'remove files from',
  rmdir: 'remove directories from',
  mv: 'move files to/from',
  cp: 'copy files to/from',
  cat: 'concatenate files from',
  head: 'read the beginning of files from',
  tail: 'read the end of files from',
  sort: 'sort contents of files from',
  uniq: 'filter duplicate lines from files in',
  wc: 'count lines/words/bytes in files from',
  cut: 'extract columns from files in',
  paste: 'merge files from',
  column: 'format files from',
  tr: 'transform text from files in',
  file: 'examine file types in',
  stat: 'read file stats from',
  diff: 'compare files from',
  awk: 'process text from files in',
  strings: 'extract strings from files in',
  hexdump: 'display hex dump of files from',
  od: 'display octal dump of files from',
  base64: 'encode/decode files from',
  nl: 'number lines in files from',
  grep: 'search for patterns in files from',
  rg: 'search for patterns in files from',
  sed: 'edit files in',
  git: 'access files with git from',
  jq: 'process JSON from files in',
  sha256sum: 'compute SHA-256 checksums for files in',
  sha1sum: 'compute SHA-1 checksums for files in',
  md5sum: 'compute MD5 checksums for files in',
  tee: 'write to files in',
  gawk: 'process text from files in',
  mawk: 'process text from files in',
  nawk: 'process text from files in',
  egrep: 'search for patterns in files from',
  fgrep: 'search for patterns in files from',
  tac: 'read files (reversed) from',
  rev: 'read files (reversed lines) from',
  fold: 'wrap lines of files from',
  expand: 'convert tabs in files from',
  unexpand: 'convert spaces in files from',
  fmt: 'reformat files from',
  comm: 'compare files from',
  cmp: 'compare files from',
  pr: 'paginate files from',
  numfmt: 'reformat numbers in files from',
  tsort: 'sort files from',
  man: 'read manual page files from',
}
// CLI 2.1.304 chunk-4b60tdnk.js: D0() detects glob-bearing argv
// values and E0o() adds those not already covered by the original extractor.
// The 2.1.88 AST now carries the 2.1.304 argvUnquotedGlob source provenance.
// If it is unavailable or cannot be aligned after wrapper stripping, retain
// the newer source's fail-closed fallback and validate every glob-shaped arg.
function hasNewerGlobArgument(value) {
  for (let i=0;i<value.length;i++) {
    const ch=value[i];
    if(ch==='*'||ch==='?')return true;
    if(ch==='['&&value.indexOf(']',i+1)!==-1)return true;
  }
  return false;
}

// CLI 2.1.304 chunk-4b60tdnk.js: d1t()/u1t() Git-global-option carve-out.
// These options consume a following argv value before the subcommand.
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C','-c','--git-dir','--work-tree','--namespace','--super-prefix',
  '--config-env','--attr-source','--shallow-file',
]);
const GIT_ENV_AFFECTING = /^(HOME|XDG_CONFIG_HOME|PROGRAMDATA|GIT_DIR|GIT_COMMON_DIR|GIT_CEILING_DIRECTORIES|GIT_EXEC_PATH|PATH)$|^GIT_CONFIG/i;
function containsTrackedBashValue(value) {
  return typeof value==='string' &&
    (value.includes('__CMDSUB_OUTPUT__') || value.includes('__TRACKED_VAR__'));
}
function parseGitGlobalOptions(args) {
  const options=[];
  let index=0;
  while(index<args.length && args[index].startsWith('-')) {
    const opt=args[index++];
    if(GIT_GLOBAL_OPTIONS_WITH_VALUE.has(opt) && index<args.length) {
      options.push({opt,value:args[index++]});
    } else {
      options.push({opt});
    }
  }
  return {index,options};
}
function hasNewerQuoteScanCarveOut(sourceCommand) {
  if(sourceCommand?.carveOutMayDesyncQuoteScan===true)return true;
  // The pinned 2.1.88 walker does not expose 2.1.304's P/l quote-scan
  // counter. Fail closed for commands containing shell expansions; ordinary
  // quoted glob literals retain their per-argv provenance.
  return /(?:\$\(|\$\{|\$[A-Za-z_#?$@*!0-9-]|\x60)/.test(
    typeof sourceCommand?.text==='string' ? sourceCommand.text : '',
  );
}
function shouldCarveOutGitGlob(command,args,sourceCommand) {
  if(command!=='git' || !sourceCommand || !Array.isArray(sourceCommand.argv))
    return false;
  const originalArgv=sourceCommand.argv;
  const prefixCount=originalArgv.length-args.length-1;
  if(prefixCount<0 ||
     originalArgv.slice(0,prefixCount).some(value=>(/(^|[\\/])env$/).test(value)))
    return false;
  if((sourceCommand.envVars??[]).some(value=>GIT_ENV_AFFECTING.test(value.name)))
    return false;
  const {index,options}=parseGitGlobalOptions(args);
  const subcommand=args[index];
  const provenance=sourceCommand.argvUnquotedGlob;
  const commandOffset=originalArgv.length-args.length;
  const globBeforeSubcommand=
    provenance===undefined ||
    provenance.length!==originalArgv.length ||
    commandOffset<1 ||
    provenance.slice(0,commandOffset+index+1).some(Boolean);
  const unsafeOption=options.some(({opt,value})=>{
    if(opt==='--bare' || opt.startsWith('--config-env') ||
       opt.startsWith('--exec-path') || opt.startsWith('--git-dir'))
      return true;
    const trimmed=typeof value==='string' ? value.trim() : '';
    return containsTrackedBashValue(trimmed) ||
      /^(alias|include|includeif|help\.autocorrect)\b/i.test(trimmed);
  });
  return !unsafeOption && !globBeforeSubcommand &&
    subcommand!==undefined && !containsTrackedBashValue(subcommand) &&
    subcommand!=='grep' && subcommand!=='diff';
}
export function getNewerBashExtraGlobPaths(command,args,sourceCommand) {
  const extractor=getOriginalBashPathExtractor(command);
  const extracted=new Set(extractor ? extractor(args) : []);
  // Match the 2.1.304 Git carve-out before the general quote-scan fallback.
  if(shouldCarveOutGitGlob(command,args,sourceCommand))return [];
  const originalArgv=sourceCommand?.argv;
  const provenance=sourceCommand?.argvUnquotedGlob;
  const prefix=Array.isArray(originalArgv)
    ? originalArgv.length-args.length : -1;
  const hasReliableProvenance=Array.isArray(provenance) &&
    Array.isArray(originalArgv) &&
    provenance.length===originalArgv.length &&
    prefix>=0 &&
    originalArgv.slice(prefix).every((value,index)=>value===args[index]);
  const carveOutMayDesync=hasNewerQuoteScanCarveOut(sourceCommand);
  return args.filter((arg,index)=>{
    if(!hasNewerGlobArgument(arg)||extracted.has(arg))return false;
    // 2.1.304 returns all glob-shaped argv values when its quote scanner
    // cannot be proven aligned; otherwise only shell-expanded argv positions.
    return carveOutMayDesync || !hasReliableProvenance ||
      provenance[prefix+index]===true;
  });
}

function validateCommandPaths(command,args,cwd,toolPermissionContext,compoundCommandHasCd,operationTypeOverride,extraReadPaths=[]) {
  const extractor = getOriginalBashPathExtractor(command)
  if(!extractor)return {
    behavior:'ask',
    message:'No source path extractor is available for '+command+'.',
    decisionReason:{type:'other',reason:'Missing original Bash path extractor'},
  }
  const paths = extractor(args)
  const operationType = operationTypeOverride ?? getOriginalBashPathOperationType(command)

  // CLI 2.1.304 chunk-4b60tdnk.js: l1t() validates cp/mv source operands
  // as reads in addition to the command's normal destination/write checks.
  // Keep both checks: Edit(path) still governs the source command's path
  // classification, while Read(path) deny/ask rules govern source contents.
  const sourceReadPaths=(command==='cp'||command==='mv')&&paths.length>=2
    ?paths.slice(0,-1):[]
  const checks=[
    ...paths.map(path=>({path,operationType})),
    ...sourceReadPaths.map(path=>({path,operationType:'read'})),
    ...extraReadPaths.filter(path=>!paths.includes(path)&&
      !sourceReadPaths.includes(path))
      .map(path=>({path,operationType:'read'})),
  ]
  const checked=checks.map(({path,operationType:pathOperationType})=>({path,pathOperationType,
    ...validatePath(path,cwd,toolPermissionContext,pathOperationType)}))

  // The newer path checker collects all path results before returning an
  // explicit rule DENY. Do not let an earlier path ASK hide a later source
  // Read(path)/Edit(path) DENY (notably cp/mv with multiple operands).
  const denied=checked.find(result=>!result.allowed &&
    result.decisionReason?.type==='rule' &&
    (operationType==='read'||!containsTrackedBashValue(result.path)))
  if(denied){
    const workingDirs=Array.from(allWorkingDirectories(toolPermissionContext))
    const dirListStr=formatDirectoryList(workingDirs)
    const message=denied.decisionReason?.type==='other'||
      denied.decisionReason?.type==='safetyCheck'
      ?denied.decisionReason.reason
      :`${command} in '${denied.resolvedPath}' was blocked. For security, Claude Code may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`
    return {behavior:'deny',message,decisionReason:denied.decisionReason}
  }

  // CLI 2.1.304 chunk-4b60tdnk.js R0o(): a write/create operand containing
  // command-substitution or tracked-variable output is runtime-determined.
  // The old AST keeps these values as placeholders; validating the literal
  // placeholder path would incorrectly authorize a different runtime path.
  if(operationType!=='read'&&paths.some(containsTrackedBashValue)){
    return {
      behavior:'ask',
      message:command+' target contains command-substitution or untracked-variable output — the path is runtime-determined and cannot be validated',
      decisionReason:{
        type:'other',
        reason:command+' path argument is runtime-determined',
        bashMissKind:'shell-expansion',
      },
    }
  }

  // SECURITY: Check command-specific validators (e.g., to block flags that could bypass path validation).
  // 2.1.304 k0o() rejects cp/mv flags and permits cd at most one positional path.
  const validator = NEWER_COMMAND_VALIDATOR[command]??COMMAND_VALIDATOR[command]
  if (validator && !validator(args)) {
    return {
      behavior: 'ask',
      message: command==='cd'
        ? 'cd with two or more directory arguments requires manual approval. The zsh OLD NEW form substitutes OLD with NEW in $PWD, producing a target path that cannot be statically validated.'
        : command+' with flags requires manual approval to ensure path safety. For security, Claude Code cannot automatically validate '+command+' commands that use flags, as some flags like --target-directory=PATH can bypass path validation.',
      decisionReason: {
        type: 'other',
        reason: command==='cd'?'cd with two or more directory arguments':command+' command with flags requires manual approval',
      },
    }
  }

  // CLI 2.1.304 chunk-4b60tdnk.js R0o(): when a compound command changes
  // directory, a relative read cannot be matched to its eventual file if
  // Read(path) deny rules (or blockReadsOutsideWorkingDirectories) are active.
  // Check this before exact/whole-tool Bash grants can restore authorization.
  const hasReadDeny=hasOriginalReadDenyRules(toolPermissionContext);
  const blocksOutsideReads=
    toolPermissionContext.blockReadsOutsideWorkingDirectories===true;
  if(compoundCommandHasCd && command!=='cd' && operationType==='read' &&
     (hasReadDeny||blocksOutsideReads) &&
     [...paths,...extraReadPaths].some(path=>
       typeof path==='string'&&!isAbsolute(path)&&
       path!=='~'&&!path.startsWith('~/'))){
    const reason=hasReadDeny
      ?'Compound command contains cd with a relative file read while a Read() deny rule exists'
      :'A relative read after cd cannot be checked against the configured working-directory boundary';
    return {
      behavior:'ask',
      message:command+' reads a relative path after a directory change; the target cannot be resolved safely and requires approval.',
      decisionReason:{type:'other',reason,bashMissKind:'cd-compound-read'},
    };
  }

  // SECURITY: Block write operations in compound commands containing 'cd'.
  // The source checker does not assume a statically known post-cd working directory.
  if (compoundCommandHasCd && operationType !== 'read') {
    return {
      behavior: 'ask',
      message: `Commands that change directories and perform write operations require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory when 'cd' is used in compound commands.`,
      decisionReason: {
        type: 'other',
        reason:
          'Compound command contains cd with write operation - manual approval required to prevent path resolution bypass',
      },
    }
  }

  const failed=checked.find(result=>!result.allowed)
  if(failed){
    const workingDirs=Array.from(allWorkingDirectories(toolPermissionContext))
    const dirListStr=formatDirectoryList(workingDirs)
    const message=
      failed.decisionReason?.type==='other'||
      failed.decisionReason?.type==='safetyCheck'
        ?failed.decisionReason.reason
        :`${command} in '${failed.resolvedPath}' was blocked. For security, Claude Code may only ${ACTION_VERBS[command]} the allowed working directories for this session: ${dirListStr}.`
    if(failed.decisionReason?.type==='rule')
      return {behavior:'deny',message,decisionReason:failed.decisionReason}
    return {
      behavior:'ask',
      message,
      blockedPath:failed.resolvedPath,
      decisionReason:failed.decisionReason,
      pathOperationType:failed.pathOperationType,
    }
  }

  return {
    behavior:'passthrough',
    message:`Path validation passed for ${command} command`,
  }
}
export function createPathChecker(command,operationTypeOverride) {
  return (args,cwd,context,compoundCommandHasCd,extraReadPaths=[]) => {
    // First check normal path validation (which includes explicit deny rules)
    const result = validateCommandPaths(
      command,
      args,
      cwd,
      context,
      compoundCommandHasCd,
      operationTypeOverride,
      extraReadPaths,
    )

    // If explicitly denied, respect that (don't override with dangerous path message)
    if (result.behavior === 'deny') {
      return result
    }

    // Check for dangerous removal paths AFTER explicit deny rules but BEFORE other results
    // This ensures the check runs even if the user has allowlist rules or if glob patterns
    // were rejected, but respects explicit deny rules. Dangerous patterns get a specific
    // error message that overrides generic glob pattern rejection messages.
    if (command === 'rm' || command === 'rmdir') {
      const dangerousPathResult = checkDangerousRemovalPaths(command, args, cwd)
      if (dangerousPathResult.behavior !== 'passthrough') {
        return dangerousPathResult
      }
    }

    // If it's a passthrough, return it directly
    if (result.behavior === 'passthrough') {
      return result
    }

    // If it's an ask decision, add suggestions based on the operation type
    if (result.behavior === 'ask') {
      const operationType = result.pathOperationType ??
        operationTypeOverride ?? COMMAND_OPERATION_TYPE[command]
      const {pathOperationType:_pathOperationType,...publicResult}=result
      const suggestions = []

      // Only suggest adding directory/rules if we have a blocked path
      if (result.blockedPath) {
        if (operationType === 'read') {
          // For read operations, suggest a Read rule for the directory (only if it exists)
          const dirPath = getDirectoryForPath(result.blockedPath)
          const suggestion = createReadRuleSuggestion(dirPath, 'session')
          if (suggestion) {
            suggestions.push(suggestion)
          }
        } else {
          // For write/create operations, suggest adding the directory
          suggestions.push({
            type: 'addDirectories',
            directories: [getDirectoryForPath(result.blockedPath)],
            destination: 'session',
          })
        }
      }

      // For write operations, also suggest enabling accept-edits mode
      if (operationType === 'write' || operationType === 'create') {
        suggestions.push({
          type: 'setMode',
          mode: 'acceptEdits',
          destination: 'session',
        })
      }

      publicResult.suggestions = suggestions
      return publicResult
    }

    // Return the decision directly
    return result
  }
}
function getDirectoryForPath(path) {
  const absolutePath = expandPath(path)
  // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // Path doesn't exist or can't be accessed
  }
  // If it's not a directory or doesn't exist, return the parent directory
  return dirname(absolutePath)
}
function createReadRuleSuggestion(dirPath,destination='session') {
  // Convert to POSIX format for pattern matching (handles Windows internally)
  const pathForPattern = toPosixPath(dirPath)

  // Root directory is too broad to be a reasonable permission target
  if (pathForPattern === '/') {
    return undefined
  }

  // For absolute paths, prepend an extra / to create //path/** pattern
  const ruleContent = posix.isAbsolute(pathForPattern)
    ? `/${pathForPattern}/**`
    : `${pathForPattern}/**`

  return {
    type: 'addRules',
    rules: [
      {
        toolName: 'Read',
        ruleContent,
      },
    ],
    behavior: 'allow',
    destination,
  }
}
export function validateOriginalBashPathCommand(command,args,cwd,context,{
  compoundCommandHasCd=false,operationTypeOverride,extraReadPaths=[],
}={}){
  try{return createPathChecker(command,operationTypeOverride)(args,cwd,
    {...context,__cliWorkspace:cwd},compoundCommandHasCd,extraReadPaths);}
  catch(error){
    return {behavior:'ask',message:'Original BashTool.createPathChecker failed: '+String(error?.message??error),
      decisionReason:{type:'other',reason:'Original command path checker failed closed'}};
  }
}
