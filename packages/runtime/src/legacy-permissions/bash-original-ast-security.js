/**
 * Runtime dependency adapter for the user-owned ORIGINAL CLI 2.1.88
 * utils/bash/{bashParser,parser,ast}.ts. All three source bodies are stored
 * verbatim alongside this adapter, and are NOT reimplemented as regexes.
 *
 * Node 22.16's built-in TypeScript type stripper converts erasable syntax
 * to JS. The source parser uses bun:bundle/Growthbook feature flags and
 * analytics exclusively for Bun-native availability and telemetry. The
 * original pure-TypeScript parser in bashParser.ts is available on all
 * Node/Windows installations; enable this existing implementation instead
 * of falling back to the old shell-quote parser.
 *
 * No filesystem JS output or generated user-content code is executed. Every
 * loaded byte comes from the pinned, checked-in 2.1.88 source files.
 */
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

let cachedSourceAst;
function moduleUrl(js) {
  return 'data:text/javascript;base64,' +
    Buffer.from(js,'utf8').toString('base64');
}
async function loadSourceAst() {
  const source=new URL('../legacy-bash-ast-source/',import.meta.url);
  const read=async name=>readFile(new URL(name+'.ts',source),'utf8');
  const parser=moduleUrl(stripTypeScriptTypes(await read('bashParser'),{
    mode:'strip',
  }));
  // Original parser.ts relies on Bun tree-sitter feature gating and
  // analytics logging. Those are platform-service dependencies, not parser
  // logic. Node uses its source pure-TS getParserModule() implementation.
  let raw=await read('parser');
  raw=raw.replace(
    "import { feature } from 'bun:bundle'",
    "const feature = flag => flag==='TREE_SITTER_BASH' || flag==='TREE_SITTER_BASH_SHADOW'",
  ).replace(
    "import { logEvent } from '../../services/analytics/index.js'",
    'const logEvent = () => {}',
  ).replace(
    "import { logForDebugging } from '../debug.js'",
    'const logForDebugging = () => {}',
  ).replace("'./bashParser.js'","'"+parser+"'");
  const service=moduleUrl(stripTypeScriptTypes(raw,{mode:'strip'}));
  let ast=await read('ast');
  ast=ast.replace("'./bashParser.js'","'"+parser+"'")
    .replaceAll("'./parser.js'","'"+service+"'");
  const security=moduleUrl(stripTypeScriptTypes(ast,{mode:'strip'}));
  return import(security);
}
export async function assessOriginalBashSecurity(command) {
  try {
    cachedSourceAst??=loadSourceAst();
    const { parseForSecurity, checkSemantics }=await cachedSourceAst;
    const parsed=await parseForSecurity(command);
    if(parsed.kind!=='simple')return parsed;
    const semantics=checkSemantics(parsed.commands);
    return semantics.ok?parsed:{
      kind:'too-complex',
      reason:semantics.reason,
    };
  }catch(error){
    // The ORIGINAL too-complex result is a hard stop for automatic
    // authorization; a loader/parsing fault must never be an allow.
    cachedSourceAst=undefined;
    return {
      kind:'too-complex',
      reason:'Original 2.1.88 Bash AST unavailable: '+
        (error instanceof Error?error.message:String(error)),
    };
  }
}

export const parseOriginalBashForSecurity=assessOriginalBashSecurity;
