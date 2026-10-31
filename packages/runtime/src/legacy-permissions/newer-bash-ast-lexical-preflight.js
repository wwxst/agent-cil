/**
 * CLI 2.1.304 AST preflight additions not present in the pinned 2.1.88
 * parseForSecurityFromAst() lexical pre-check chain.
 *
 * Provenance: supplied cli-2.1.304/modules/chunk-jfhbcs0s.js
 * zK() → v0r / T0r. Regex expressions and source reasons are copied
 * directly; these checks run before the old 2.1.88 AST is trusted.
 *
 * This module does not tokenize, split or interpret a shell command.
 * All other old source checks and original parser behavior stay intact.
 */
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ZSH_NUMERIC_RANGE_RE = /<\d*-\d*>/;

const BACKTICK=String.fromCharCode(96);
function checkBacktickDifferential(command) {
  let singleQuote=false,doubleQuote=false,wordStart=true;
  let backtickStart=-1,bodyStart=-1,innerSingleQuote=false,innerDoubleQuote=false;
  let unsupportedEscape=false;
  for(let i=0;i<command.length;){
    const ch=command[i],next=command[i+1],next2=command[i+2];
    if(backtickStart>=0){
      if(innerSingleQuote){
        if(ch==="'")innerSingleQuote=false;
        i++;continue;
      }
      if(ch==='\\'){
        if(next===BACKTICK||next==='\\'||next==='$'){i+=2;continue;}
        if(next==='\n'){i+=2;continue;}
        if(next==='\r'&&next2==='\n'){i+=3;continue;}
        unsupportedEscape=true;
        if(next===undefined){i++;continue;}
        i+=2;continue;
      }
      if(ch==="'"&&!innerDoubleQuote){innerSingleQuote=true;i++;continue;}
      if(ch==='"'){innerDoubleQuote=!innerDoubleQuote;i++;continue;}
      if(ch===BACKTICK){
        const body=command.slice(bodyStart,i).replace(/\\\r?\n/g,'').trim();
        if(body===''){
          return {kind:'too-complex',reason:'empty backtick substitution — bash joins the surrounding words, so parsed command boundaries cannot be trusted',differential:true};
        }
        if(unsupportedEscape){
          return {kind:'too-complex',reason:'backtick substitution scan could not be trusted (backtick_escape_unsupported) — parsed bytes may differ from what bash executes',differential:true};
        }
        backtickStart=-1;bodyStart=-1;innerSingleQuote=false;innerDoubleQuote=false;unsupportedEscape=false;
        i++;continue;
      }
      i++;continue;
    }
    if(singleQuote){
      if(ch==="'")singleQuote=false;
      i++;continue;
    }
    if(doubleQuote){
      if(ch==='\\'&&(next==='"'||next==='\\'||next===BACKTICK)){i+=2;continue;}
      if(ch===BACKTICK){
        backtickStart=i;bodyStart=i+1;innerSingleQuote=false;innerDoubleQuote=false;unsupportedEscape=false;
        i++;continue;
      }
      if(ch==='"')doubleQuote=false;
      i++;continue;
    }
    if(ch==='\\'){
      if(next===undefined){i++;continue;}
      if(next==='\n'){i+=2;continue;}
      if(next==='\r'&&next2==='\n'){i+=3;continue;}
      wordStart=false;i+=2;continue;
    }
    if(ch==='#'&&wordStart){
      while(i<command.length&&command[i]!=='\n')i++;
      wordStart=true;continue;
    }
    if(ch==="'"){singleQuote=true;wordStart=false;i++;continue;}
    if(ch==='"'){doubleQuote=true;wordStart=false;i++;continue;}
    if(ch===BACKTICK){
      backtickStart=i;bodyStart=i+1;innerSingleQuote=false;innerDoubleQuote=false;unsupportedEscape=false;
      wordStart=false;i++;continue;
    }
    wordStart=ch===' '||ch==='\t'||ch==='\n'||ch===';'||ch==='|'||
      ch==='&'||ch==='('||ch===')'||ch==='<'||ch==='>';
    i++;
  }
  if(backtickStart>=0){
    return {kind:'too-complex',reason:'backtick substitution scan could not be trusted (backtick_body_overrun) — parsed bytes may differ from what bash executes',differential:true};
  }
  return null;
}

export function checkNewerBashAstLexicalPreflight(command) {
  if (LONE_SURROGATE_RE.test(command))
    return {
      kind: 'too-complex',
      reason: 'Contains lone surrogate',
      differential: true,
    };
  if (ZSH_NUMERIC_RANGE_RE.test(command))
    return {
      kind: 'too-complex',
      reason: 'Contains zsh <N-M> numeric-range glob',
      differential: true,
    };
  const backtick = checkBacktickDifferential(command);
  if (backtick) return backtick;
  return {kind: 'passthrough'};
}

export {LONE_SURROGATE_RE, ZSH_NUMERIC_RANGE_RE};
