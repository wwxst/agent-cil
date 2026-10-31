/**
 * Pinned CLI 2.1.88 BashTool/bashSecurity.ts direct source bodies:
 * extractQuotedContent, stripSafeRedirections, validateIFSInjection, validateProcEnvironAccess, validateMalformedTokenInjection, isEscapedAtPosition, validateBraceExpansion, validateMidWordHash, validateDangerousVariables.
 * TypeScript-only annotations erased; original function bodies preserved.
 * The original quoted-only extractHeredocs() is not yet wired; defer the
 * new source quote-view checks for heredocs to existing authoritative AST.
 * This is NOT the complete 2.1.88 bashCommandIsSafe_DEPRECATED dispatcher.
 */
import {tryParseShellCommand,hasMalformedTokens} from './bash-shell-quote.js';
import {extractHeredocs} from './original-bash-heredoc.js';
const logEvent=()=>{};
const BASH_SECURITY_CHECK_IDS={
  IFS_INJECTION:11,PROC_ENVIRON_ACCESS:13,MALFORMED_TOKEN_INJECTION:14,
  BRACE_EXPANSION:16,MID_WORD_HASH:18,DANGEROUS_VARIABLES:6,
};
function extractQuotedContent(command,isJq = false) {
  let withDoubleQuotes = ''
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += char
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      // For jq, include quotes in extraction to ensure content is properly analyzed
      if (!isJq) continue
    }

    if (!inSingleQuote) withDoubleQuotes += char
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
    if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

function stripSafeRedirections(content) {
  // SECURITY: All three patterns MUST have a trailing boundary (?=\s|$).
  // Without it, `> /dev/nullo` matches `/dev/null` as a PREFIX, strips
  // `> /dev/null` leaving `o`, so `echo hi > /dev/nullo` becomes `echo hi o`.
  // validateRedirections then sees no `>` and passes. The file write to
  // /dev/nullo is auto-allowed via the read-only path (checkReadOnlyConstraints).
  // Main bashPermissions flow is protected (checkPathConstraints validates the
  // original command), but speculation.ts uses checkReadOnlyConstraints alone.
  return content
    .replace(/\s+2\s*>&\s*1(?=\s|$)/g, '')
    .replace(/[012]?\s*>\s*\/dev\/null(?=\s|$)/g, '')
    .replace(/\s*<\s*\/dev\/null(?=\s|$)/g, '')
}

function validateIFSInjection(context) {
  const { originalCommand } = context

  // Detect any usage of IFS variable which could be used to bypass regex validation
  // Check for $IFS and ${...IFS...} patterns (including parameter expansions like ${IFS:0:1}, ${#IFS}, etc.)
  // Using ${[^}]*IFS to catch all parameter expansion variations with IFS
  if (/\$IFS|\$\{[^}]*IFS/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.IFS_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains IFS variable usage which could bypass security validation',
    }
  }

  return { behavior: 'passthrough', message: 'No IFS injection detected' }
}

function validateProcEnvironAccess(context) {
  const { originalCommand } = context

  // Check for /proc paths that could expose environment variables
  // This catches patterns like:
  // - /proc/self/environ
  // - /proc/1/environ
  // - /proc/*/environ (with any PID)
  if (/\/proc\/.*\/environ/.test(originalCommand)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.PROC_ENVIRON_ACCESS,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command accesses /proc/*/environ which could expose sensitive environment variables',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No /proc/environ access detected',
  }
}

function validateMalformedTokenInjection(context) {
  const { originalCommand } = context

  const parseResult = tryParseShellCommand(originalCommand)
  if (!parseResult.success) {
    // Parse failed - this is handled elsewhere (bashToolHasPermission checks this)
    return {
      behavior: 'passthrough',
      message: 'Parse failed, handled elsewhere',
    }
  }

  const parsed = parseResult.tokens

  // Check for command separators (;, &&, ||)
  const hasCommandSeparator = parsed.some(
    entry =>
      typeof entry === 'object' &&
      entry !== null &&
      'op' in entry &&
      (entry.op === ';' || entry.op === '&&' || entry.op === '||'),
  )

  if (!hasCommandSeparator) {
    return { behavior: 'passthrough', message: 'No command separators' }
  }

  // Check for malformed tokens (unbalanced delimiters)
  if (hasMalformedTokens(originalCommand, parsed)) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MALFORMED_TOKEN_INJECTION,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains ambiguous syntax with command separators that could be misinterpreted',
    }
  }

  return {
    behavior: 'passthrough',
    message: 'No malformed token injection detected',
  }
}

function isEscapedAtPosition(content,pos) {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

function validateBraceExpansion(context) {
  // Use pre-strip content to avoid false negatives from stripSafeRedirections
  // creating backslash adjacencies (e.g., `\>/dev/null{a,b}` → `\{a,b}` after
  // stripping, making isEscapedAtPosition think the brace is escaped).
  const content = context.fullyUnquotedPreStrip

  // SECURITY: Check for MISMATCHED brace counts in fullyUnquoted content.
  // A mismatch indicates that quoted braces (e.g., `'{'` or `"{"`) were
  // stripped by extractQuotedContent, leaving unbalanced braces in the content
  // we analyze. Our depth-matching algorithm below assumes balanced braces —
  // with a mismatch, it closes at the WRONG position, missing commas that
  // bash's algorithm WOULD find.
  //
  // Exploit: `git diff {@'{'0},--output=/tmp/pwned}`
  //   - Original: 2 `{`, 2 `}` (quoted `'{'` counts as content, not operator)
  //   - fullyUnquoted: `git diff {@0},--output=/tmp/pwned}` — 1 `{`, 2 `}`!
  //   - Our depth-matcher: closes at first `}` (after `0`), inner=`@0`, no `,`
  //   - Bash (on original): quoted `{` is content; first unquoted `}` has no
  //     `,` yet → bash treats as literal content, keeps scanning → finds `,`
  //     → final `}` closes → expands to `@{0} --output=/tmp/pwned`
  //   - git writes diff to /tmp/pwned. ARBITRARY FILE WRITE, ZERO PERMISSIONS.
  //
  // We count ONLY unescaped braces (backslash-escaped braces are literal in
  // bash). If counts mismatch AND at least one unescaped `{` exists, block —
  // our depth-matching cannot be trusted on this content.
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) {
      unescapedOpenBraces++
    } else if (content[i] === '}' && !isEscapedAtPosition(content, i)) {
      unescapedCloseBraces++
    }
  }
  // Only block when CLOSE count EXCEEDS open count — this is the specific
  // attack signature. More `}` than `{` means a quoted `{` was stripped
  // (bash saw it as content, we see extra `}` unaccounted for). The inverse
  // (more `{` than `}`) is usually legitimate unclosed/escaped braces like
  // `{foo` or `{a,b\}` where bash doesn't expand anyway.
  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
      subId: 2,
    })
    return {
      behavior: 'ask',
      message:
        'Command has excess closing braces after quote stripping, indicating possible brace expansion obfuscation',
    }
  }

  // SECURITY: Additionally, check the ORIGINAL command (before quote stripping)
  // for `'{'` or `"{"` INSIDE an unquoted brace context — this is the specific
  // attack primitive. A quoted brace inside an outer unquoted `{...}` is
  // essentially always an obfuscation attempt; legitimate commands don't nest
  // quoted braces inside brace expansion (awk/find patterns are fully quoted,
  // like `awk '{print $1}'` where the OUTER brace is inside quotes too).
  //
  // This catches the attack even if an attacker crafts a payload with balanced
  // stripped braces (defense-in-depth). We use a simple heuristic: if the
  // original command has `'{'` or `'}'` or `"{"` or `"}"` (quoted single brace)
  // AND also has an unquoted `{`, that's suspicious.
  if (unescapedOpenBraces > 0) {
    const orig = context.originalCommand
    // Look for quoted single-brace patterns: '{', '}', "{",  "}"
    // These are the attack primitive — a brace char wrapped in quotes.
    if (/['"][{}]['"]/.test(orig)) {
      logEvent('tengu_bash_security_check_triggered', {
        checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
        subId: 3,
      })
      return {
        behavior: 'ask',
        message:
          'Command contains quoted brace character inside brace context (potential brace expansion obfuscation)',
      }
    }
  }

  // Scan for unescaped `{` characters, then check if they form brace expansion.
  // We use a manual scan rather than a simple regex lookbehind because
  // lookbehinds can't handle double-escaped backslashes (\\{ is unescaped `{`).
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue
    if (isEscapedAtPosition(content, i)) continue

    // Find matching unescaped `}` by tracking nesting depth.
    // Previous approach broke on nested `{`, missing commas between the outer
    // `{` and the nested one (e.g., `{--upload-pack="evil",{test}}`).
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) {
        depth++
      } else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }

    if (matchingClose === -1) continue

    // Check for `,` or `..` at the outermost nesting level between this
    // `{` and its matching `}`. Only depth-0 triggers matter — bash splits
    // brace expansion at outer-level commas/sequences.
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) {
        innerDepth++
      } else if (ch === '}' && !isEscapedAtPosition(content, k)) {
        innerDepth--
      } else if (innerDepth === 0) {
        if (
          ch === ',' ||
          (ch === '.' && k + 1 < matchingClose && content[k + 1] === '.')
        ) {
          logEvent('tengu_bash_security_check_triggered', {
            checkId: BASH_SECURITY_CHECK_IDS.BRACE_EXPANSION,
            subId: 1,
          })
          return {
            behavior: 'ask',
            message:
              'Command contains brace expansion that could alter command parsing',
          }
        }
      }
    }
    // No expansion at this level — don't skip past; inner pairs will be
    // caught by subsequent iterations of the outer loop.
  }

  return {
    behavior: 'passthrough',
    message: 'No brace expansion detected',
  }
}

function validateMidWordHash(context) {
  const { unquotedKeepQuoteChars } = context
  // Match # preceded by a non-whitespace character (mid-word hash).
  // shell-quote treats mid-word # as comment-start but bash treats it as a
  // literal character, creating a parser differential.
  //
  // Uses unquotedKeepQuoteChars (which preserves quote delimiters but strips
  // quoted content) to catch quote-adjacent # like 'x'# — fullyUnquotedPreStrip
  // would strip both quotes and content, turning 'x'# into just # (word-start).
  //
  // SECURITY: Also check the CONTINUATION-JOINED version. The context is built
  // from the original command (pre-continuation-join). For `foo\<NL>#bar`,
  // pre-join the `#` is preceded by `\n` (whitespace → `/\S#/` doesn't match),
  // but post-join it's preceded by `o` (non-whitespace → matches). shell-quote
  // operates on the post-join text (line continuations are joined in
  // splitCommand), so the parser differential manifests on the joined text.
  // While not directly exploitable (the `#...` fragment still prompts as its
  // own subcommand), this is a defense-in-depth gap — shell-quote would drop
  // post-`#` content from path extraction.
  //
  // Exclude ${# which is bash string-length syntax (e.g., ${#var}).
  // Note: the lookbehind must be placed immediately before # (not before \S)
  // so that it checks the correct 2-char window.
  const joined = unquotedKeepQuoteChars.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  })
  if (
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() with atom search: fast when # absent
    /\S(?<!\$\{)#/.test(unquotedKeepQuoteChars) ||
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    /\S(?<!\$\{)#/.test(joined)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.MID_WORD_HASH,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains mid-word # which is parsed differently by shell-quote vs bash',
    }
  }
  return { behavior: 'passthrough', message: 'No mid-word hash' }
}

function validateDangerousVariables(context) {
  const { fullyUnquotedContent } = context

  if (
    /[<>|]\s*\$[A-Za-z_]/.test(fullyUnquotedContent) ||
    /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(fullyUnquotedContent)
  ) {
    logEvent('tengu_bash_security_check_triggered', {
      checkId: BASH_SECURITY_CHECK_IDS.DANGEROUS_VARIABLES,
      subId: 1,
    })
    return {
      behavior: 'ask',
      message:
        'Command contains variables in dangerous contexts (redirections or pipes)',
    }
  }

  return { behavior: 'passthrough', message: 'No dangerous variables' }
}
export function checkOriginalBashFurtherMisparsing(command){
  if(typeof command!=='string'||!command.trim())
    return {behavior:'passthrough',message:'Empty command left to original AST'};
  // Exact 2.1.88 bashCommandIsSafe_DEPRECATED heredoc prelude:
  // only quoted delimiters suppress body expansion. Original source
  // returns the raw string when boundaries are ambiguous.
  const {processedCommand}=extractHeredocs(command,{quotedOnly:true});
  const {withDoubleQuotes,fullyUnquoted,unquotedKeepQuoteChars}=
    extractQuotedContent(processedCommand,command.split(' ')[0]==='jq');
  const context={
    originalCommand:command,baseCommand:command.split(' ')[0]||'',
    unquotedContent:withDoubleQuotes,
    fullyUnquotedContent:stripSafeRedirections(fullyUnquoted),
    fullyUnquotedPreStrip:fullyUnquoted,
    unquotedKeepQuoteChars,
  };
  for(const check of [
    validateDangerousVariables,
    validateIFSInjection,
    validateProcEnvironAccess,
    validateBraceExpansion,
    validateMidWordHash,
    validateMalformedTokenInjection,
  ]){
    const result=check(context);
    if(result.behavior==='ask')
      return {...result,isBashSecurityCheckForMisparsing:true};
  }
  return {behavior:'passthrough',message:'Further original validators passed'};
}
export {extractQuotedContent,stripSafeRedirections,validateIFSInjection,validateProcEnvironAccess,validateMalformedTokenInjection,isEscapedAtPosition,validateBraceExpansion,validateMidWordHash,validateDangerousVariables};
