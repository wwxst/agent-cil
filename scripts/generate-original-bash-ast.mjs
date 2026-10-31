/**
 * Reproducible BUILD-TIME only transpilation of the USER-OWNED verbatim
 * original CLI 2.1.88 Bash parser, parser ownership and AST walker.
 *
 * Output is checked into the PR after generation. The actual CLI loads
 * checked-in JS and NEVER calls stripTypeScriptTypes() at runtime, keeping
 * Node >=22 and Windows behavior stable. No new grammar/security algorithm.
 *
 * Run with Node >=22.16: node scripts/generate-original-bash-ast.mjs
 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const original=join(root,'packages/runtime/src/legacy-bash-ast-source');
const generated=join(root,'packages/runtime/src/legacy-permissions/generated');
await mkdir(generated,{recursive:true});
const read=name=>readFile(join(original,name+'.ts'),'utf8');
const requireReplacement=(contents,previous,next,file)=>{
  if(contents.split(previous).length!==2){
    throw new Error('Original 2.1.88 '+file+' import changed unexpectedly: '+previous);
  }
  return contents.replace(previous,next);
};
const checked=(source,file)=>{
  if(typeof stripTypeScriptTypes!=='function'){
    throw new Error('Node >=22.16 with type stripping is needed to BUILD Bash AST JS');
  }
  return '/* GENERATED from pinned original 2.1.88 '+file+
    '.ts. Do not edit. Regenerate using scripts/generate-original-bash-ast.mjs. */\n'+
    stripTypeScriptTypes(source,{mode:'strip'});
};

const bashSource=await read('bashParser');
await writeFile(join(generated,'bashParser.js'),
  checked(bashSource,'bashParser'));
let parser=await read('parser');
parser=requireReplacement(parser,"import { feature } from 'bun:bundle'",
  "const feature = flag => flag==='TREE_SITTER_BASH' || flag==='TREE_SITTER_BASH_SHADOW'",
  'parser');
parser=requireReplacement(parser,
  "import { logEvent } from '../../services/analytics/index.js'",
  'const logEvent = () => {}','parser');
parser=requireReplacement(parser,
  "import { logForDebugging } from '../debug.js'",
  'const logForDebugging = () => {}','parser');
await writeFile(join(generated,'parser.js'),checked(parser,'parser'));
let ast=await read('ast');
ast=requireReplacement(ast,
  "import { T as hasUnquotedGlob } from '../legacy-permissions/original-bash-find-awk-semantics.js'",
  "import { T as hasUnquotedGlob } from '../original-bash-find-awk-semantics.js'",
  'ast');
await writeFile(join(generated,'ast.js'),checked(ast,'ast'));
// Direct 2.1.88 BashTool/pathValidation.ts:1176–1304. Preserve the
// mature wrapper stripping call chain (timeout/nice/stdbuf/env/time/nohup)
// and strip only erasable TypeScript annotations. Fail if source changes.
const sourcePathValidation=await read('pathValidation');
const wrapperAnchor='const TIMEOUT_FLAG_VALUE_RE =';
if(sourcePathValidation.split(wrapperAnchor).length!==2){
  throw new Error('Original BashTool.pathValidation wrapper region changed');
}
let wrappers=wrapperAnchor+sourcePathValidation.split(wrapperAnchor)[1];
const wrapperForms=[
  ['a: readonly string[]','a'],
  ['argv: string[]','argv'],
  ['): number',')'],
  ['): string[]',')'],
];
for(const [typed,plain] of wrapperForms){
  if(!wrappers.includes(typed)) {
    throw new Error('Original Bash wrapper TS type annotation changed: '+typed);
  }
  wrappers=wrappers.replaceAll(typed,plain);
}
wrappers=wrappers.replaceAll(']!',']');
await writeFile(join(generated,'stripWrappers.js'),
  '/* GENERATED from pinned 2.1.88 BashTool/pathValidation.ts wrapper dependency. Do not edit. */\n'+wrappers);

/* Build-time mechanical erasure from original BashTool/pathValidation.ts.
 * Never replace these mature PATH_EXTRACTORS with heuristic shell parsing. */
function sourceRegion(start,end){
  const a=sourcePathValidation.indexOf(start);
  const b=sourcePathValidation.indexOf(end,a+start.length);
  if(a<0||b<0||sourcePathValidation.indexOf(start,a+1)>=0){
    throw new Error('Original BashTool.pathValidation region changed: '+start);
  }
  return sourcePathValidation.slice(a,b);
}
let originalPaths=sourceRegion('function filterOutFlags(', '\nconst SUPPORTED_PATH_COMMANDS =')
  +'\n'+sourceRegion('const COMMAND_VALIDATOR:', '\nfunction validateCommandPaths(')
  +'\nexport { COMMAND_VALIDATOR };\n'
  +'\n'+sourceRegion('export const COMMAND_OPERATION_TYPE:', '\n/**\n * Command-specific validators');
const originalPathTypeErasures=[["function filterOutFlags(args: string[]): string[] {","function filterOutFlags(args) {"],["function parsePatternCommand(\n  args: string[],\n  flagsWithArgs: Set<string>,\n  defaults: string[] = [],\n): string[] {","function parsePatternCommand(args, flagsWithArgs, defaults = []) {"],["export const PATH_EXTRACTORS: Record<\n  PathCommand,\n  (args: string[]) => string[]\n> = {","export const PATH_EXTRACTORS = {"],["const paths: string[] = []","const paths = []"],["const result: string[] = []","const result = []"],["(args: string[]) => !args.some","(args) => !args.some"],["const COMMAND_VALIDATOR: Partial<\n  Record<PathCommand, (args: string[]) => boolean>\n> = {","const COMMAND_VALIDATOR = {"],["export const COMMAND_OPERATION_TYPE: Record<PathCommand, FileOperationType> = {","export const COMMAND_OPERATION_TYPE = {"]];
for(const [before,after] of originalPathTypeErasures){
  if(!originalPaths.includes(before)){
    throw new Error('Original Bash path extractor type annotation changed: '+before);
  }
  originalPaths=originalPaths.replaceAll(before,after);
}
await writeFile(join(generated,'originalPathExtractors.js'),
  "/* GENERATED from pinned original CLI 2.1.88 BashTool/pathValidation.ts PATH_EXTRACTORS and COMMAND_VALIDATOR. Do not edit. */\nimport { homedir } from 'node:os';\n"+originalPaths);
process.stdout.write('Generated the original Bash AST and PATH_EXTRACTORS into '+generated+'\n');
