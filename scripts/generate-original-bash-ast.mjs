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
const ast=await read('ast');
await writeFile(join(generated,'ast.js'),checked(ast,'ast'));
process.stdout.write('Generated the three ORIGINAL Bash AST source modules into '+generated+'\n');
