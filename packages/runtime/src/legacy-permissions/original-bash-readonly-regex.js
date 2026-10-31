/**
 * CLI 2.1.88 BashTool/readOnlyValidation.ts source regex branch, preserved
 * verbatim except TypeScript erasure. The source COMMAND_ALLOWLIST flag
 * parser remains disabled on Windows until the configured Bash distribution
 * and external utility PATH provenance are pinned; regex-only source checks
 * remain available after the caller's AST/path/redirect checks.
 *
 * Source sections: makeRegexForSafeCommand(), READONLY_COMMANDS,
 * READONLY_COMMAND_REGEXES, containsUnquotedExpansion() and
 * isCommandReadOnly(). Original shared
 * shell/readOnlyCommandValidation.ts:containsVulnerableUncPath().
 *
 * This grants only proven single-command source-regex reads and cannot
 * stand in for the complete original checkReadOnlyConstraints(), sandbox,
 * git/path checks, flag maps, or compound commands. The caller must
 * execute all source AST/security/path/redirect/deny checks first.
 */
import {isCommandSafeViaFlagParsing} from './original-bash-readonly-flags.js';
import {isCurrentDirectoryBareGitRepo} from './original-bash-bare-git.js';
import {isAbsolute,resolve} from 'node:path';
const EXTERNAL_READONLY_COMMANDS=['docker ps','docker images']; // source shared map
const getPlatform=()=>process.platform==='win32'?'windows':process.platform;
function containsVulnerableUncPath(pathOrCommand) {
  // Only check on Windows platform
  if (getPlatform() !== 'windows') {
    return false
  }

  // 1. Check for general UNC paths with backslashes
  // Pattern matches: \\server, \\server\share, \\server/share, \\server@port\share
  // Uses [^\s\\/]+ for hostname to catch Unicode homoglyphs and other non-ASCII chars
  // Trailing accepts both \ and / since Windows treats both as path separators
  const backslashUncPattern = /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (backslashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 2. Check for forward-slash UNC paths
  // Pattern matches: //server, //server/share, //server\share, //192.168.1.1/share
  // Uses negative lookbehind (?<!:) to exclude URLs (https://, http://, ftp://)
  // while catching // preceded by quotes, =, or any other non-colon character.
  // Trailing accepts both / and \ since Windows treats both as path separators
  const forwardSlashUncPattern =
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- .test() on short command strings
    /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i
  if (forwardSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 3. Check for mixed-separator UNC paths (forward slash + backslashes)
  // On Windows/Cygwin, /\ is equivalent to // since both are path separators.
  // In bash, /\\server becomes /\server after escape processing, which is a UNC path.
  // Requires 2+ backslashes after / because a single backslash just escapes the next char
  // (e.g., /\a → /a after bash processing, which is NOT a UNC path).
  const mixedSlashUncPattern = /\/\\{2,}[^\s\\/]/
  if (mixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 4. Check for mixed-separator UNC paths (backslashes + forward slash)
  // \\/server in bash becomes \/server after escape processing, which is a UNC path
  // on Windows since both \ and / are path separators.
  const reverseMixedSlashUncPattern = /\\{2,}\/[^\s\\/]/
  if (reverseMixedSlashUncPattern.test(pathOrCommand)) {
    return true
  }

  // 5. Check for WebDAV SSL/port patterns
  // Examples: \\server@SSL@8443\path, \\server@8443@SSL\path
  if (/@SSL@\d+/i.test(pathOrCommand) || /@\d+@SSL/i.test(pathOrCommand)) {
    return true
  }

  // 6. Check for DavWWWRoot marker (Windows WebDAV redirector)
  // Example: \\server\DavWWWRoot\path
  if (/DavWWWRoot/i.test(pathOrCommand)) {
    return true
  }

  // 7. Check for UNC paths with IPv4 addresses (explicit check for defense-in-depth)
  // Examples: \\192.168.1.1\share, \\10.0.0.1\path
  if (
    /^\\\\(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand) ||
    /^\/\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  // 8. Check for UNC paths with bracketed IPv6 addresses (explicit check for defense-in-depth)
  // Examples: \\[2001:db8::1]\share, \\[::1]\path
  if (
    /^\\\\(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand) ||
    /^\/\/(\[[\da-fA-F:]+\])[\\/]/.test(pathOrCommand)
  ) {
    return true
  }

  return false
}


function makeRegexForSafeCommand(command) {
  // Create regex pattern: /^command(?:\s|$)[^<>()$`|{}&;\n\r]*$/
  return new RegExp(`^${command}(?:\\s|$)[^<>()$\`|{}&;\\n\\r]*$`)
}

// Simple commands that are safe for execution (converted to regex patterns using makeRegexForSafeCommand)
// WARNING: If you are adding new commands here, be very careful to ensure
// they are truly safe. This includes ensuring:
// 1. That they don't have any flags that allow file writing or command execution
// 2. Use makeRegexForSafeCommand() to ensure proper regex pattern creation
const READONLY_COMMANDS = [
  // Cross-platform commands from shared validation
  ...EXTERNAL_READONLY_COMMANDS,

  // Unix/bash-specific read-only commands (not shared because they don't exist in PowerShell)

  // Time and date
  'cal',
  'uptime',

  // File content viewing (relative paths handled separately)
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'strings',
  'hexdump',
  'od',
  'nl',

  // System info
  'id',
  'uname',
  'free',
  'df',
  'du',
  'locale',
  'groups',
  'nproc',

  // Path information
  'basename',
  'dirname',
  'realpath',

  // Text processing
  'cut',
  'paste',
  'tr',
  'column',
  'tac', // Reverse cat — displays file contents in reverse line order
  'rev', // Reverse characters in each line
  'fold', // Wrap lines to specified width
  'expand', // Convert tabs to spaces
  'unexpand', // Convert spaces to tabs
  'fmt', // Simple text formatter — output to stdout only
  'comm', // Compare sorted files line by line
  'cmp', // Byte-by-byte file comparison
  'numfmt', // Number format conversion

  // Path information (additional)
  'readlink', // Resolve symlinks — displays target of symbolic link

  // File comparison
  'diff',

  // true and false, used to silence or create errors
  'true',
  'false',

  // Misc. safe commands
  'sleep',
  'which',
  'type',
  'expr', // Evaluate expressions (arithmetic, string matching)
  'test', // Conditional evaluation (file checks, comparisons)
  'getconf', // Get system configuration values
  'seq', // Generate number sequences
  'tsort', // Topological sort
  'pr', // Paginate files for printing
]

// Complex commands that require custom regex patterns
// Warning: If possible, avoid adding new regexes here and prefer using COMMAND_ALLOWLIST
// instead. This allowlist-based approach to CLI flags is more secure and avoids
// vulns coming from gnu getopt_long.
const READONLY_COMMAND_REGEXES = new Set([
  // Convert simple commands to regex patterns using makeRegexForSafeCommand
  ...READONLY_COMMANDS.map(makeRegexForSafeCommand),

  // Echo that doesn't execute commands or use variables
  // Allow newlines in single quotes (safe) but not in double quotes (could be dangerous with variable expansion)
  // Also allow optional 2>&1 stderr redirection at the end
  /^echo(?:\s+(?:'[^']*'|"[^"$<>\n\r]*"|[^|;&`$(){}><#\\!"'\s]+))*(?:\s+2>&1)?\s*$/,

  // Claude CLI help
  /^claude -h$/,
  /^claude --help$/,

  // Git readonly commands are now handled via COMMAND_ALLOWLIST with explicit flag validation
  // (git status, git blame, git ls-files, git config --get, git remote, git tag, git branch)

  /^uniq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?|-[fsw]\s+\d+))*(?:\s|$)\s*$/, // Only allow flags, no input/output files

  // System info
  /^pwd$/,
  /^whoami$/,
  // env and printenv removed - could expose sensitive environment variables

  // Development tools version checking - exact match only, no suffix allowed.
  // SECURITY: `node -v --run <task>` would execute package.json scripts because
  // Node processes --run before -v. Python/python3 --version are also anchored
  // for defense-in-depth. These were previously in EXTERNAL_READONLY_COMMANDS which
  // flows through makeRegexForSafeCommand and permits arbitrary suffixes.
  /^node -v$/,
  /^node --version$/,
  /^python --version$/,
  /^python3 --version$/,

  // Misc. safe commands
  // tree command moved to COMMAND_ALLOWLIST for proper flag validation (blocks -o/--output)
  /^history(?:\s+\d+)?\s*$/, // Only allow bare history or history with numeric argument - prevents file writing
  /^alias$/,
  /^arch(?:\s+(?:--help|-h))?\s*$/, // Only allow arch with help flags or no arguments

  // Network commands - only allow exact commands with no arguments to prevent network manipulation
  /^ip addr$/, // Only allow "ip addr" with no additional arguments
  /^ifconfig(?:\s+[a-zA-Z][a-zA-Z0-9_-]*)?\s*$/, // Allow ifconfig with interface name only (must start with letter)

  // JSON processing with jq - allow with inline filters and file arguments
  // File arguments are validated separately by pathValidation.ts
  // Allow pipes and complex expressions within quotes but prevent dangerous flags
  // Block command substitution - backticks are dangerous even in single quotes for jq
  // Block -f/--from-file, --rawfile, --slurpfile (read files into jq), --run-tests, -L/--library-path (load executable modules)
  // Block 'env' builtin and '$ENV' object which can access environment variables (defense in depth)
  /^jq(?!\s+.*(?:-f\b|--from-file|--rawfile|--slurpfile|--run-tests|-L\b|--library-path|\benv\b|\$ENV\b))(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+(?:=\S+)?))*(?:\s+'[^'`]*'|\s+"[^"`]*"|\s+[^-\s'"][^\s]*)+\s*$/,

  // Path commands (path validation ensures they're allowed)
  // cd command - allows changing to directories
  /^cd(?:\s+(?:'[^']*'|"[^"]*"|[^\s;|&`$(){}><#\\]+))?$/,
  // ls command - allows listing directories
  /^ls(?:\s+[^<>()$`|{}&;\n\r]*)?$/,
  // find command - blocks dangerous flags
  // Allow escaped parentheses \( and \) for grouping, but block unescaped ones
  // NOTE: \\[()] must come BEFORE the character class to ensure \( is matched as an escaped paren,
  // not as backslash + paren (which would fail since paren is excluded from the character class)
  /^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/,
])


function containsUnquotedExpansion(command) {
  // Track quote state to avoid false positives for patterns inside quoted strings
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const currentChar = command[i]

    // Handle escape sequences
    if (escaped) {
      escaped = false
      continue
    }

    // SECURITY: Only treat backslash as escape OUTSIDE single quotes. In bash,
    // `\` inside `'...'` is LITERAL — it does not escape the next character.
    // Without this guard, `'\'` desyncs the quote tracker: the `\` sets
    // escaped=true, then the closing `'` is consumed by the escaped-skip
    // instead of toggling inSingleQuote. Parser stays in single-quote
    // mode for the rest of the command, missing ALL subsequent expansions.
    // Example: `ls '\' *` — bash sees glob `*`, but desynced parser thinks
    // `*` is inside quotes → returns false (glob NOT detected).
    // Defense-in-depth: hasShellQuoteSingleQuoteBug catches `'\'` patterns
    // before this function is reached, but we fix the tracker anyway for
    // consistency with the correct implementations in bashSecurity.ts.
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }

    // Update quote state
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    // Inside single quotes: everything is literal. Skip.
    if (inSingleQuote) {
      continue
    }

    // Check `$` followed by variable-name or special-parameter character.
    // `$` expands inside double quotes AND unquoted (only SQ makes it literal).
    if (currentChar === '$') {
      const next = command[i + 1]
      if (next && /[A-Za-z_@*#?!$0-9-]/.test(next)) {
        return true
      }
    }

    // Globs are literal inside double quotes too. Only check unquoted.
    if (inDoubleQuote) {
      continue
    }

    // Check for glob characters outside all quotes.
    // These could expand to anything, including dangerous flags.
    if (currentChar && /[?*[\]]/.test(currentChar)) {
      return true
    }
  }

  return false
}


function isCommandReadOnly(command) {
  // Handle common stderr-to-stdout redirection pattern
  // This handles both "command 2>&1" at the end of a full command
  // and "command 2>&1" as part of a pipeline component
  let testCommand = command.trim()
  if (testCommand.endsWith(' 2>&1')) {
    // Remove the stderr redirection for pattern matching
    testCommand = testCommand.slice(0, -5).trim()
  }

  // Check for Windows UNC paths that could be vulnerable to WebDAV attacks
  // Do this early to prevent any command with UNC paths from being marked as read-only
  if (containsVulnerableUncPath(testCommand)) {
    return false
  }

  // Check for unquoted glob characters and expandable `$` variables that could
  // bypass our regex-based security checks. We can't know what these expand to
  // at runtime, so we can't verify the command is read-only.
  //
  // Globs: `python *` could expand to `python --help` if such a file exists.
  //
  // Variables: `uniq --skip-chars=0$_` — bash expands `$_` at runtime to the
  // last arg of the previous command. With IFS word splitting, this smuggles
  // positional args past "flags-only" regexes like uniq's `\S+`. The `$` token
  // check inside isCommandSafeViaFlagParsing only covers COMMAND_ALLOWLIST
  // commands; hand-written regexes in READONLY_COMMAND_REGEXES (uniq, jq, cd)
  // have no such guard. See containsUnquotedExpansion for full analysis.
  if (containsUnquotedExpansion(testCommand)) {
    return false
  }

  // 2.1.88 full original command allowlist + source shared flag validator.
  // The native Windows CLI currently launches cmd.exe (Node spawn(shell:true))
  // Windows launches an explicit bash.exe under the Job Object supervisor,
  // not cmd.exe. However the configured Bash distribution can inherit a PATH
  // where System32 sort.exe precedes GNU sort; keep the source flag parser
  // disabled until external utility identity and PATH order are authenticated.
  if (process.platform!=='win32' && isCommandSafeViaFlagParsing(testCommand)) {
    return true
  }

  for (const regex of READONLY_COMMAND_REGEXES) {
    if (regex.test(testCommand)) {
      // Prevent git commands with -c flag to avoid config options that can lead to code execution
      // The -c flag allows setting arbitrary git config values inline, including dangerous ones like
      // core.fsmonitor, diff.external, core.gitProxy, etc. that can execute arbitrary commands
      // Check for -c preceded by whitespace and followed by whitespace or equals
      // Using regex to catch spaces, tabs, and other whitespace (not part of other flags like --cached)
      if (testCommand.includes('git') && /\s-c[\s=]/.test(testCommand)) {
        return false
      }

      // Prevent git commands with --exec-path flag to avoid path manipulation that can lead to code execution
      // The --exec-path flag allows overriding the directory where git looks for executables
      if (
        testCommand.includes('git') &&
        /\s--exec-path[\s=]/.test(testCommand)
      ) {
        return false
      }

      // Prevent git commands with --config-env flag to avoid config injection via environment variables
      // The --config-env flag allows setting git config values from environment variables, which can be
      // just as dangerous as -c flag (e.g., core.fsmonitor, diff.external, core.gitProxy)
      if (
        testCommand.includes('git') &&
        /\s--config-env[\s=]/.test(testCommand)
      ) {
        return false
      }
      return true
    }
  }
  return false
}


export function checkOriginalReadOnlyRegexBranch(command,{workspace,originalCwd=workspace,sandboxEnabled}={}){
  if(typeof command!=='string'||!command.trim())
    return {behavior:'passthrough',message:'Empty read-only command'};
  if(/[\r\n]/.test(command))
    return {behavior:'passthrough',message:'Multiline read-only command requires original checks'};
  // Original checkReadOnlyConstraints() git bare repository + sandbox/cwd
  // restrictions. Only actual CLI Bash workspace may provide provenance:
  // without a real sandbox owner we must be explicitly non-sandboxed.
  if(/^\s*git(?:\s|$)/.test(command)){
    if(process.platform==='win32')
      return {behavior:'passthrough',message:'Windows Git executable/worktree provenance is not verified'};
    if(typeof workspace!=='string'||!isAbsolute(workspace)||
       sandboxEnabled!==false||typeof originalCwd!=='string'||
       !isAbsolute(originalCwd)||resolve(workspace)!==resolve(originalCwd))
      return {behavior:'passthrough',message:'Original Git cwd/sandbox provenance unverified'};
    try{
      if(isCurrentDirectoryBareGitRepo(workspace))
        return {behavior:'passthrough',
          message:'Git commands in directories with bare repository structure require permission checks for enhanced security'};
    }catch{
      return {behavior:'passthrough',message:'Original Git bare repository check failed'};
    }
  }
  if(isCommandReadOnly(command))
    return {behavior:'allow',updatedInput:{command},
      decisionReason:{type:'other',reason:'Read-only command is allowed'}};
  return {behavior:'passthrough',message:'Command not validated as source regex read-only'};
}
export {isCommandReadOnly,containsUnquotedExpansion,READONLY_COMMAND_REGEXES};
