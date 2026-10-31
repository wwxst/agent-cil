/**
 * Direct original 2.1.88 src/utils/bash/shellQuote.ts parser guards.
 * Source function bodies preserved except TypeScript signature stripping
 * and dependency logError (analytics logger not yet ported).
 * `shell-quote` dependency vendored unmodified from MIT v1.8.3 source.
 *
 * Caution: parser differentials are why the original CLI also uses AST
 * parseForSecurity and bashCommandIsSafe. Do not use this to auto-allow
 * broad shell permissions on its own.
 */
import shellQuoteParse from './vendor/shell-quote-parse.cjs';
import shellQuoteQuote from './vendor/shell-quote-quote.cjs';
export const quote = shellQuoteQuote;

export function tryParseShellCommand(cmd, env) {
  try {
    const tokens =
      typeof env === 'function'
        ? shellQuoteParse(cmd, env)
        : shellQuoteParse(cmd, env)
    return { success: true, tokens }
  } catch (error) {
    if (error instanceof Error) {
      // The source logError analytics dependency is not yet ported.
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parse error',
    }
  }
}

export function hasMalformedTokens(command, parsed) {
  // Check for unterminated quotes in the original command. shell-quote drops
  // an unmatched quote without leaving any trace in the tokens, so this must
  // inspect the raw string. Walk with bash semantics: backslash escapes the
  // next char outside single-quotes; no escapes inside single-quotes.
  let inSingle = false
  let inDouble = false
  let doubleCount = 0
  let singleCount = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\' && !inSingle) {
      i++
      continue
    }
    if (c === '"' && !inSingle) {
      doubleCount++
      inDouble = !inDouble
    } else if (c === "'" && !inDouble) {
      singleCount++
      inSingle = !inSingle
    }
  }
  if (doubleCount % 2 !== 0 || singleCount % 2 !== 0) return true

  for (const entry of parsed) {
    if (typeof entry !== 'string') continue

    // Check for unbalanced curly braces
    const openBraces = (entry.match(/{/g) || []).length
    const closeBraces = (entry.match(/}/g) || []).length
    if (openBraces !== closeBraces) return true

    // Check for unbalanced parentheses
    const openParens = (entry.match(/\(/g) || []).length
    const closeParens = (entry.match(/\)/g) || []).length
    if (openParens !== closeParens) return true

    // Check for unbalanced square brackets
    const openBrackets = (entry.match(/\[/g) || []).length
    const closeBrackets = (entry.match(/\]/g) || []).length
    if (openBrackets !== closeBrackets) return true

    // Check for unbalanced double quotes
    // Count quotes that aren't escaped (preceded by backslash)
    // A token with an odd number of unescaped quotes is malformed
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- gated by hasCommandSeparator check at caller, runs on short per-token strings
    const doubleQuotes = entry.match(/(?<!\\)"/g) || []
    if (doubleQuotes.length % 2 !== 0) return true

    // Check for unbalanced single quotes
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    const singleQuotes = entry.match(/(?<!\\)'/g) || []
    if (singleQuotes.length % 2 !== 0) return true
  }
  return false
}

export function hasShellQuoteSingleQuoteBug(command) {
  // Walk the command with correct bash single-quote semantics
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // Handle backslash escaping outside of single quotes
    if (char === '\\' && !inSingleQuote) {
      // Skip the next character (it's escaped)
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote

      // Check if we just closed a single quote and the content ends with
      // trailing backslashes. shell-quote's chunker regex '((\\'|[^'])*?)'
      // incorrectly treats \' as an escape sequence inside single quotes,
      // while bash treats backslash as literal. This creates a differential
      // where shell-quote merges tokens that bash treats as separate.
      //
      // Odd trailing \'s = always a bug:
      //   '\' -> shell-quote: \' = literal ', still open. bash: \, closed.
      //   'abc\' -> shell-quote: abc then \' = literal ', still open. bash: abc\, closed.
      //   '\\\'  -> shell-quote: \\ + \', still open. bash: \\\, closed.
      //
      // Even trailing \'s = bug ONLY when a later ' exists in the command:
      //   '\\' alone -> shell-quote backtracks, both parsers agree string closes. OK.
      //   '\\' 'next' -> shell-quote: \' consumes the closing ', finds next ' as
      //                   false close, merges tokens. bash: two separate tokens.
      //
      //   Detail: the regex alternation tries \' before [^']. For '\\', it matches
      //   the first \ via [^'] (next char is \, not '), then the second \ via \'
      //   (next char IS '). This consumes the closing '. The regex continues reading
      //   until it finds another ' to close the match. If none exists, it backtracks
      //   to [^'] for the second \ and closes correctly. If a later ' exists (e.g.,
      //   the opener of the next single-quoted arg), no backtracking occurs and
      //   tokens merge. See H1 report: git ls-remote 'safe\\' '--upload-pack=evil' 'repo'
      //   shell-quote: ["git","ls-remote","safe\\\\ --upload-pack=evil repo"]
      //   bash:        ["git","ls-remote","safe\\\\","--upload-pack=evil","repo"]
      if (!inSingleQuote) {
        let backslashCount = 0
        let j = i - 1
        while (j >= 0 && command[j] === '\\') {
          backslashCount++
          j--
        }
        if (backslashCount > 0 && backslashCount % 2 === 1) {
          return true
        }
        // Even trailing backslashes: only a bug when a later ' exists that
        // the chunker regex can use as a false closing quote. We check for
        // ANY later ' because the regex doesn't respect bash quote state
        // (e.g., a ' inside double quotes is also consumable).
        if (
          backslashCount > 0 &&
          backslashCount % 2 === 0 &&
          command.indexOf("'", i + 1) !== -1
        ) {
          return true
        }
      }
      continue
    }
  }

  return false
}

