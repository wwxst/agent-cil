/**
 * Original CLI 2.1.88 Bash security AST dependency.
 *
 * No runtime type-stripper, eval, alternate grammar or Bun dependency.
 * The user-owned verbatim TypeScript parser, parser service and AST walker
 * are retained in ../legacy-bash-ast-source/*.ts. Generated Node ESM in
 * ./generated/*.js is deterministically built from that pinned source by
 * scripts/generate-original-bash-ast.mjs (and CI verifies source parity).
 *
 * Lazy loading avoids parsing the AST engine unless a real Bash tool is
 * checked for permissions. All source exceptions are fail-closed.
 */
let cachedSourceAst;

export async function assessOriginalBashSecurity(command) {
  try {
    cachedSourceAst??=import('./generated/ast.js');
    const {parseForSecurity,checkSemantics}=await cachedSourceAst;
    const parsed=await parseForSecurity(command);
    if(parsed.kind!=='simple')return parsed;
    const semantics=checkSemantics(parsed.commands);
    return semantics.ok?parsed:{
      kind:'too-complex',
      reason:semantics.reason,
      // The original bashToolHasPermission() preserves the successfully
      // parsed SimpleCommand[] across checkSemantics failure and executes
      // checkSemanticsDeny() on EVERY subcommand before returning ask.
      // Never discard the AST evidence merely because semantic checks fail.
      sourceCommands:parsed.commands,
      semanticFailure:true,
    };
  }catch(error){
    cachedSourceAst=undefined;
    return {
      kind:'too-complex',
      reason:'Original 2.1.88 Bash AST unavailable: '+
        (error instanceof Error?error.message:String(error)),
    };
  }
}
export const parseOriginalBashForSecurity=assessOriginalBashSecurity;
