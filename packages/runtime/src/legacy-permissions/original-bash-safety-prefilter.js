/**
 * Pinned 2.1.88 BashTool/bashSecurity.ts misparsing validator source.
 * 8 mature methods carried verbatim except TS parameter/result annotation:
 * validateCarriageReturn, hasBackslashEscapedWhitespace, validateBackslashEscapedWhitespace, hasBackslashEscapedOperator, validateBackslashEscapedOperators, validateUnicodeWhitespace, validateCommentQuoteDesync, validateQuotedNewline.
 *
 * These independent validators originally run inside
 * bashCommandIsSafe_DEPRECATED(). They now execute as a fail-closed
 * pre-authorization step before the original tree-sitter AST. No new
 * shell grammar or replace-all security heuristic is introduced.
 *
 * The other original bashSecurity.ts validators and its complete
 * dispatcher are still outstanding and must be migrated separately.
 * logEvent was telemetry only; native CLI has no old analytics process.
 */
const logEvent=()=>{};
const BASH_SECURITY_CHECK_IDS = {
  INCOMPLETE_COMMANDS: 1,
  JQ_SYSTEM_FUNCTION: 2,
  JQ_FILE_ARGUMENTS: 3,
  OBFUSCATED_FLAGS: 4,
  SHELL_METACHARACTERS: 5,
  DANGEROUS_VARIABLES: 6,
  NEWLINES: 7,
  DANGEROUS_PATTERNS_COMMAND_SUBSTITUTION: 8,
  DANGEROUS_PATTERNS_INPUT_REDIRECTION: 9,
  DANGEROUS_PATTERNS_OUTPUT_REDIRECTION: 10,
  IFS_INJECTION: 11,
  GIT_COMMIT_SUBSTITUTION: 12,
  PROC_ENVIRON_ACCESS: 13,
  MALFORMED_TOKEN_INJECTION: 14,
  BACKSLASH_ESCAPED_WHITESPACE: 15,
  BRACE_EXPANSION: 16,
  CONTROL_CHARACTERS: 17,
  UNICODE_WHITESPACE: 18,
  MID_WORD_HASH: 19,
  ZSH_DANGEROUS_COMMANDS: 20,
  BACKSLASH_ESCAPED_OPERATORS: 21,
  COMMENT_QUOTE_DESYNC: 22,
  QUOTED_NEWLINE: 23,
}
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])
const UNICODE_WS_RE =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/

function validateCarriageReturn(context) {
  const { originalCommand } = context

  if (!originalCommand.includes('\r')) {
    return { behavior: 'passthrough', message: 'No carriage return' }
  }

  // Check if CR appears outside double quotes. CR outside DQ (including inside
  // SQ and unquoted) causes the shell-quote/bash tokenization differential.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < originalCommand.length; i++) {
    const c = originalCommand[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (c === '\r' && !inDoubleQuote) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.NEWLINES,
        subId: 2,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains carriage return (\\r) which shell-quote and bash tokenize differently',
      }
    }
  }

  return { behavior: 'passthrough', message: 'CR only inside double quotes' }
}

function hasBackslashEscapedWhitespace(command) {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar === ' ' || nextChar === '\t') {
          return true
        }
      }
      // Skip the escaped character (both outside quotes and inside double quotes,
      // where \\, \", \$, \` are valid escape sequences)
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedWhitespace(
  context) {
  if (hasBackslashEscapedWhitespace(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains backslash-escaped whitespace that could alter command parsing',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped whitespace',
  }
}

function hasBackslashEscapedOperator(command) {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // SECURITY: Handle backslash FIRST, before quote toggles. In bash, inside
    // double quotes, `\"` is an escape sequence producing a literal `"` — it
    // does NOT close the quote. If we process quote toggles first, `\"` inside
    // `"..."` desyncs the tracker:
    //   - `\` is ignored (gated by !inDoubleQuote)
    //   - `"` toggles inDoubleQuote to FALSE (wrong — bash says still inside)
    //   - next `"` (the real closing quote) toggles BACK to TRUE — locked desync
    //   - subsequent `\;` is missed because !inDoubleQuote is false
    // Exploit: `tac "x\"y" \; echo ~/.ssh/id_rsa` — bash runs ONE tac reading
    // all args as files (leaking id_rsa), but desynced tracker misses `\;` and
    // splitCommand's double-parse normalization "sees" two safe commands.
    //
    // Fix structure matches hasBackslashEscapedWhitespace (which was correctly
    // fixed for this in commit prior to d000dfe84e): backslash check first,
    // gated only by !inSingleQuote (since backslash IS literal inside '...'),
    // unconditional i++ to skip the escaped char even inside double quotes.
    if (char === '\\' && !inSingleQuote) {
      // Only flag \<operator> when OUTSIDE double quotes (inside double quotes,
      // operators like ;|&<> are already not special, so \; is harmless there).
      if (!inDoubleQuote) {
        const nextChar = command[i + 1]
        if (nextChar && SHELL_OPERATORS.has(nextChar)) {
          return true
        }
      }
      // Skip the escaped character unconditionally. Inside double quotes, this
      // correctly consumes backslash pairs: `"x\\"` → pos 6 (`\`) skips pos 7
      // (`\`), then pos 8 (`"`) toggles inDoubleQuote off correctly. Without
      // unconditional skip, pos 7 would see `\`, see pos 8 (`"`) as nextChar,
      // skip it, and the closing quote would NEVER toggle inDoubleQuote —
      // permanently desyncing and missing subsequent `\;` outside quotes.
      // Exploit: `cat "x\\" \; echo /etc/passwd` — bash reads /etc/passwd.
      //
      // This correctly handles backslash parity: odd-count `\;` (1, 3, 5...)
      // is flagged (the unpaired `\` before `;` is detected). Even-count `\\;`
      // (2, 4...) is NOT flagged, which is CORRECT — bash treats `\\` as
      // literal `\` and `;` as a separator, so splitCommand handles it
      // normally (no double-parse bug). This matches
      // hasBackslashEscapedWhitespace line ~1340.
      i++
      continue
    }

    // Quote toggles come AFTER backslash handling (backslash already skipped
    // any escaped quote char, so these toggles only fire on unescaped quotes).
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
  }

  return false
}

function validateBackslashEscapedOperators(
  context) {
  // Tree-sitter path: if tree-sitter confirms no actual operator nodes exist
  // in the AST, then any \; is just an escaped character in a word argument
  // (e.g., `find . -exec cmd {} \;`). Skip the expensive regex check.
  if (context.treeSitter && !context.treeSitter.hasActualOperatorNodes) {
    return { behavior: 'passthrough', message: 'No operator nodes in AST' }
  }

  if (hasBackslashEscapedOperator(context.originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BACKSLASH_ESCAPED_OPERATORS,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains a backslash before a shell operator (;, |, &, <, >) which can hide command structure',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No backslash-escaped operators',
  }
}

function validateUnicodeWhitespace(
  context) {
  const { originalCommand } = context
  if (UNICODE_WS_RE.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.UNICODE_WHITESPACE,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains Unicode whitespace characters that could cause parsing inconsistencies',
    }
  }
  return { behavior: 'passthrough', message: 'No Unicode whitespace' }
}

function validateCommentQuoteDesync(
  context) {
  // Tree-sitter path: tree-sitter correctly identifies comment nodes and
  // quoted content. The desync concern is about regex quote tracking being
  // confused by quote characters inside comments. When tree-sitter provides
  // the quote context, this desync cannot happen — the AST is authoritative
  // regardless of whether the command contains a comment.
  if (context.treeSitter) {
    return {
      behavior: 'passthrough',
      message: 'Tree-sitter quote context is authoritative',
    }
  }

  const { originalCommand } = context

  // Track quote state character-by-character using the same (correct) logic
  // as extractQuotedContent: single quotes don't toggle inside double quotes.
  // When we encounter an unquoted `#`, check if the rest of the line (until
  // newline) contains any quote characters.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      // Single quotes inside double quotes are literal — no toggle
      continue
    }

    if (char === "'") {
      inSingleQuote = true
      continue
    }

    if (char === '"') {
      inDoubleQuote = true
      continue
    }

    // Unquoted `#` — in bash, this starts a comment. Check if the rest of
    // the line contains quote characters that would desync other trackers.
    if (char === '#') {
      const lineEnd = originalCommand.indexOf('\n', i)
      const commentText = originalCommand.slice(
        i + 1,
        lineEnd === -1 ? originalCommand.length : lineEnd,
      )
      if (/['"]/.test(commentText)) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.COMMENT_QUOTE_DESYNC,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains quote characters inside a # comment which can desync quote tracking',
        }
      }
      // Skip to end of line (rest is comment)
      if (lineEnd === -1) break
      i = lineEnd // Loop increment will move past newline
    }
  }

  return { behavior: 'passthrough', message: 'No comment quote desync' }
}

function validateQuotedNewline(context) {
  const { originalCommand } = context

  // Fast path: must have both a newline byte AND a # character somewhere.
  // stripCommentLines only strips lines where trim().startsWith('#'), so
  // no # means no possible trigger.
  if (!originalCommand.includes('\n') || !originalCommand.includes('#')) {
    return { behavior: 'passthrough', message: 'No newline or no hash' }
  }

  // Track quote state. Mirrors extractQuotedContent / validateCommentQuoteDesync:
  // - single quotes don't toggle inside double quotes
  // - backslash escapes the next char (but not inside single quotes)
  // stripCommentLines splits on '\n' (not \r), so we only treat \n as a line
  // separator. \r inside a line is removed by trim() and doesn't change the
  // trimmed-starts-with-# check.
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < originalCommand.length; i++) {
    const char = originalCommand[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // A newline inside quotes: the NEXT line (from bash's perspective) starts
    // inside a quoted string. Check if that line would be stripped by
    // stripCommentLines — i.e., after trim(), does it start with `#`?
    // This exactly mirrors: lines.filter(l => !l.trim().startsWith('#'))
    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = originalCommand.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? originalCommand.length : nextNewline
      const nextLine = originalCommand.slice(lineStart, lineEnd)
      if (nextLine.trim().startsWith('#')) {
        logEvent('tengu_bash_security_check_triggered', {
          checkId: BASH_SECURITY_CHECK_IDS.QUOTED_NEWLINE,
        })
        return {
          behavior: 'ask',
          message:
            'Command contains a quoted newline followed by a #-prefixed line, which can hide arguments from line-based permission checks',
        }
      }
    }
  }

  return { behavior: 'passthrough', message: 'No quoted newline-hash pattern' }
}
export function checkOriginalBashMisparsingSafety(command) {
  if(typeof command!=='string')
    return {behavior:'ask',message:'Bash command must be a string',
      isBashSecurityCheckForMisparsing:true};
  // This exact source control-char regex runs first, before shellQuote or
  // any AST parse because Bash strips null and non-printable characters.
  if(CONTROL_CHAR_RE.test(command))return {
    behavior:'ask',
    message:'Command contains non-printable control characters that could be used to bypass security checks',
    isBashSecurityCheckForMisparsing:true,
  };
  const context={originalCommand:command};
  const checks=[
    validateCarriageReturn,
    validateUnicodeWhitespace,
    validateBackslashEscapedWhitespace,
    validateBackslashEscapedOperators,
    validateCommentQuoteDesync,
    validateQuotedNewline,
  ];
  for(const check of checks){
    const result=check(context);
    if(result.behavior!=='passthrough')
      return {...result,isBashSecurityCheckForMisparsing:true};
  }
  return {behavior:'passthrough',message:'Source misparsing validators passed'};
}
export {validateCarriageReturn,hasBackslashEscapedWhitespace,validateBackslashEscapedWhitespace,hasBackslashEscapedOperator,validateBackslashEscapedOperators,validateUnicodeWhitespace,validateCommentQuoteDesync,validateQuotedNewline};
