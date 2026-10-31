/**
 * Source 2.1.88 BashTool/bashPermissions.ts and readOnlyValidation.ts:
 * isNormalizedGitCommand, isNormalizedCdCommand,
 * isGitInternalPath, extractWritePathsFromSubcommand,
 * commandWritesToGitInternalPaths.
 *
 * Source methods are retained with TS erasure. Old splitCommand_DEPRECATED
 * is replaced with the already checked original AST SimpleCommand[]; output
 * redirects come from original pathValidation AST extractor. This prevents
 * unsafe string re-parsing of the shell control-flow the original AST knows.
 * Git compound guards execute before any possible read-only auto-approval.
 */
import {stripSafeWrappers} from './bash-rule-candidates.js';
import {tryParseShellCommand} from './bash-shell-quote.js';
import {PATH_EXTRACTORS,COMMAND_OPERATION_TYPE}
  from './generated/originalPathExtractors.js';
import {astRedirectsToOutputRedirections} from './original-bash-redirections.js';
import {isCurrentDirectoryBareGitRepo} from './original-bash-bare-git.js';
import {checkOriginalReadOnlyRegexBranch} from './original-bash-readonly-regex.js';
import {resolve,isAbsolute} from 'node:path';

export function isNormalizedGitCommand(command) {
  // Fast path: catch the most common case before any parsing
  if (command.startsWith('git ') || command === 'git') {
    return true
  }
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    // Direct git command
    if (parsed.tokens[0] === 'git') {
      return true
    }
    // "xargs git ..." — xargs runs git in the current directory,
    // so it must be treated as a git command for cd+git security checks.
    // This matches the xargs prefix handling in filterRulesByContentsMatchingInput.
    if (parsed.tokens[0] === 'xargs' && parsed.tokens.includes('git')) {
      return true
    }
    return false
  }
  return /^git(?:\s|$)/.test(stripped)
}

/**
 * Checks if a subcommand is a cd command after normalizing away safe wrappers
 * (env vars, timeout, etc.) and shell quotes.
 *
 * SECURITY: Must normalize before matching to prevent bypasses like:
 *   FORCE_COLOR=1 cd sub — env var prefix hides the cd from a naive /^cd / regex
 *   This mirrors isNormalizedGitCommand to ensure symmetric normalization.
 *
 * Also matches pushd/popd — they change cwd just like cd, so
 *   pushd /tmp/bare-repo && git status
 * must trigger the same cd+git guard. Mirrors PowerShell's
 * DIRECTORY_CHANGE_ALIASES (src/utils/powershell/parser.ts).
 */
export function isNormalizedCdCommand(command) {
  const stripped = stripSafeWrappers(command)
  const parsed = tryParseShellCommand(stripped)
  if (parsed.success && parsed.tokens.length > 0) {
    const cmd = parsed.tokens[0]
    return cmd === 'cd' || cmd === 'pushd' || cmd === 'popd'
  }
  return /^(?:cd|pushd|popd)(?:\s|$)/.test(stripped)
}

/**
 * Git-internal path patterns that can be exploited for sandbox escape.
 * If a command creates these files and then runs git, the git command
 * could execute malicious hooks from the created files.
 */
const GIT_INTERNAL_PATTERNS = [
  /^HEAD$/,
  /^objects(?:\/|$)/,
  /^refs(?:\/|$)/,
  /^hooks(?:\/|$)/,
]

/**
 * Checks if a path is a git-internal path (HEAD, objects/, refs/, hooks/).
 */
export function isGitInternalPath(path) {
  // Normalize path by removing leading ./ or /
  const normalized = path.replace(/^\.?\//, '')
  return GIT_INTERNAL_PATTERNS.some(pattern => pattern.test(normalized))
}

// Commands that only delete or modify in-place (don't create new files at new paths)
const NON_CREATING_WRITE_COMMANDS = new Set(['rm', 'rmdir', 'sed'])

/**
 * Extracts write paths from a subcommand using PATH_EXTRACTORS.
 * Only returns paths for commands that can create new files/directories
 * (write/create operations excluding deletion and in-place modification).
 */
export function extractWritePathsFromSubcommand(subcommand) {
  const parseResult = tryParseShellCommand(subcommand, env => `$${env}`)
  if (!parseResult.success) return []

  const tokens = parseResult.tokens.filter(
    t => typeof t === 'string',
  )
  if (tokens.length === 0) return []

  const baseCmd = tokens[0]
  if (!baseCmd) return []

  // Only consider commands that can create files at target paths
  if (!(baseCmd in COMMAND_OPERATION_TYPE)) {
    return []
  }
  const opType = COMMAND_OPERATION_TYPE[baseCmd]
  if (
    (opType !== 'write' && opType !== 'create') ||
    NON_CREATING_WRITE_COMMANDS.has(baseCmd)
  ) {
    return []
  }

  const extractor = PATH_EXTRACTORS[baseCmd]
  if (!extractor) return []

  return extractor(tokens.slice(1))
}

/**
 * Checks if a compound command writes to any git-internal paths.
 * This is used to detect potential sandbox escape attacks where a command
 * creates git-internal files (HEAD, objects/, refs/, hooks/) and then runs git.
 *
 * SECURITY: A compound command could bypass the bare repo detection by:
 * 1. Creating bare git repo files (HEAD, objects/, refs/, hooks/) in the same command
 * 2. Then running git, which would execute malicious hooks
 *
 * Example attack:
 * mkdir -p objects refs hooks && echo '#!/bin/bash\nmalicious' > hooks/pre-commit && touch HEAD && git status
 *
 * @param command The full command string to check
 * @returns true if any subcommand writes to git-internal paths
 */
export function commandWritesToGitInternalPaths(command,commands) {
  const subcommands = commands.map(cmd=>cmd.text)

  for (const [index,subcmd] of subcommands.entries()) {
    const trimmed = subcmd.trim()

    // Check write paths from path-based commands (mkdir, touch, cp, mv)
    const writePaths = extractWritePathsFromSubcommand(trimmed)
    for (const path of writePaths) {
      if (isGitInternalPath(path)) {
        return true
      }
    }

    // Check output redirections (e.g., echo x > hooks/pre-commit)
    const {redirections} = astRedirectsToOutputRedirections(commands[index].redirects??[])
    for (const { target } of redirections) {
      if (isGitInternalPath(target)) {
        return true
      }
    }
  }

  return false
}


/** The 2.1.88 checkReadOnlyConstraints() source order, but using source
 * AST-validated leaves instead of splitCommand_DEPRECATED. No sandbox or
 * original sync fallback permission is fabricated. Every leaf still goes
 * through source isCommandReadOnly() flag/regex closure, and all callers
 * must have completed original checkSemantics/path/redirection checks.
 */
export function checkOriginalCompoundReadOnlyConstraints(input,commands,{
  workspace,originalCwd=workspace,sandboxEnabled,
}={}){
  const passthrough=message=>({behavior:'passthrough',message});
  // Windows does not use Node spawn(shell:true)/cmd.exe here. The registered
  // Bash tool resolves bash.exe and launches it directly with CreateProcessW
  // inside the existing Job Object supervisor. Apply the same source AST
  // read-only gate; retain the cwd, Git, redirection and sandbox checks below.
  if(!Array.isArray(commands)||commands.length<2||
     typeof workspace!=='string'||!isAbsolute(workspace)||
     typeof originalCwd!=='string'||!isAbsolute(originalCwd)||
     resolve(workspace)!==resolve(originalCwd)||sandboxEnabled!==false)
    return passthrough('Original compound cwd/sandbox provenance unverified');
  if(commands.some(cmd=>!cmd||!Array.isArray(cmd.argv)||
    (cmd.redirects?.length??0)>0))
    return passthrough('Original compound redirection/AST safety requires permission checks');
  const hasGitCommand=commands.some(cmd=>isNormalizedGitCommand(cmd.text));
  const compoundCommandHasCd=commands.some(cmd=>isNormalizedCdCommand(cmd.text));
  // Exact original readOnlyValidation.ts:1914-1966 Git gate order.
  if(compoundCommandHasCd&&hasGitCommand)return passthrough(
    'Compound commands with cd and git require permission checks for enhanced security');
  if(hasGitCommand){
    try{
      if(isCurrentDirectoryBareGitRepo(workspace))return passthrough(
        'Git commands in directories with bare repository structure require permission checks for enhanced security');
      if(commandWritesToGitInternalPaths(input.command,commands))return passthrough(
        'Compound commands that create git internal files and run git require permission checks for enhanced security');
    }catch{
      return passthrough('Original Git internal path inspection could not be completed');
    }
  }
  // Until original cd-after-path evaluation exists, never infer the final
  // cwd after a compound cd/pushd/popd. Old source can allow some of them,
  // but its complete path/rule closure is still unavailable here.
  if(compoundCommandHasCd)return passthrough(
    'Compound directory change needs original per-subcommand cwd validation');
  if(commands.every(cmd=>checkOriginalReadOnlyRegexBranch(cmd.text,{
    workspace,originalCwd,sandboxEnabled,
  }).behavior==='allow'))return {behavior:'allow',updatedInput:input};
  return passthrough('Command is not read-only, requires further permission checks');
}
