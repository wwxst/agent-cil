/* GENERATED from pinned original CLI 2.1.88 BashTool/pathValidation.ts PATH_EXTRACTORS and COMMAND_VALIDATOR. Do not edit. */
import { homedir } from 'node:os';
function filterOutFlags(args) {
  const result = []
  let afterDoubleDash = false
  for (const arg of args) {
    if (afterDoubleDash) {
      result.push(arg)
    } else if (arg === '--') {
      afterDoubleDash = true
    } else if (!arg?.startsWith('-')) {
      result.push(arg)
    }
  }
  return result
}

// Helper: Parse grep/rg style commands (pattern then paths)
function parsePatternCommand(args, flagsWithArgs, defaults = []) {
  const paths = []
  let patternFound = false
  // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
  // positional regardless of leading `-`. See filterOutFlags() doc comment.
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === null) continue

    if (!afterDoubleDash && arg === '--') {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith('-')) {
      const flag = arg.split('=')[0]
      // Pattern flags mark that we've found the pattern
      if (flag && ['-e', '--regexp', '-f', '--file'].includes(flag)) {
        patternFound = true
      }
      // Skip next arg if flag needs it
      if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
        i++
      }
      continue
    }

    // First non-flag is pattern, rest are paths
    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return paths.length > 0 ? paths : defaults
}

/**
 * Extracts paths from command arguments for different path commands.
 * Each command has specific logic for how it handles paths and flags.
 */
export const PATH_EXTRACTORS = {
  // cd: special case - all args form one path
  cd: args => (args.length === 0 ? [homedir()] : [args.join(' ')]),

  // ls: filter flags, default to current dir
  ls: args => {
    const paths = filterOutFlags(args)
    return paths.length > 0 ? paths : ['.']
  },

  // find: collect paths until hitting a real flag, also check path-taking flags
  // SECURITY: `find -- -path` makes `-path` a starting point (not a predicate).
  // GNU find supports `--` to allow search roots starting with `-`. After `--`,
  // we conservatively collect all remaining args as paths to validate. This
  // over-includes predicates like `-name foo`, but find is a read-only op and
  // predicates resolve to paths within cwd (allowed), so no false blocks for
  // legitimate use. The over-inclusion ensures attack paths like
  // `find -- -/../../etc` are caught.
  find: args => {
    const paths = []
    const pathFlags = new Set([
      '-newer',
      '-anewer',
      '-cnewer',
      '-mnewer',
      '-samefile',
      '-path',
      '-wholename',
      '-ilname',
      '-lname',
      '-ipath',
      '-iwholename',
    ])
    const newerPattern = /^-newer[acmBt][acmtB]$/
    let foundNonGlobalFlag = false
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!arg) continue

      if (afterDoubleDash) {
        paths.push(arg)
        continue
      }

      if (arg === '--') {
        afterDoubleDash = true
        continue
      }

      // Handle flags
      if (arg.startsWith('-')) {
        // Global options don't stop collection
        if (['-H', '-L', '-P'].includes(arg)) continue

        // Mark that we've seen a non-global flag
        foundNonGlobalFlag = true

        // Check if this flag takes a path argument
        if (pathFlags.has(arg) || newerPattern.test(arg)) {
          const nextArg = args[i + 1]
          if (nextArg) {
            paths.push(nextArg)
            i++ // Skip the path we just processed
          }
        }
        continue
      }

      // Only collect non-flag arguments before first non-global flag
      if (!foundNonGlobalFlag) {
        paths.push(arg)
      }
    }
    return paths.length > 0 ? paths : ['.']
  },

  // All simple commands: just filter out flags
  mkdir: filterOutFlags,
  touch: filterOutFlags,
  rm: filterOutFlags,
  rmdir: filterOutFlags,
  mv: filterOutFlags,
  cp: filterOutFlags,
  cat: filterOutFlags,
  head: filterOutFlags,
  tail: filterOutFlags,
  sort: filterOutFlags,
  uniq: filterOutFlags,
  wc: filterOutFlags,
  cut: filterOutFlags,
  paste: filterOutFlags,
  column: filterOutFlags,
  file: filterOutFlags,
  stat: filterOutFlags,
  diff: filterOutFlags,
  awk: filterOutFlags,
  strings: filterOutFlags,
  hexdump: filterOutFlags,
  od: filterOutFlags,
  base64: filterOutFlags,
  nl: filterOutFlags,
  sha256sum: filterOutFlags,
  sha1sum: filterOutFlags,
  md5sum: filterOutFlags,

  // tr: special case - skip character sets
  tr: args => {
    const hasDelete = args.some(
      a =>
        a === '-d' ||
        a === '--delete' ||
        (a.startsWith('-') && a.includes('d')),
    )
    const nonFlags = filterOutFlags(args)
    return nonFlags.slice(hasDelete ? 1 : 2) // Skip SET1 or SET1+SET2
  },

  // grep: pattern then paths, defaults to stdin
  grep: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '--exclude',
      '--include',
      '--exclude-dir',
      '--include-dir',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    const paths = parsePatternCommand(args, flags)
    // Special: if -r/-R flag present and no paths, use current dir
    if (
      paths.length === 0 &&
      args.some(a => ['-r', '-R', '--recursive'].includes(a))
    ) {
      return ['.']
    }
    return paths
  },

  // rg: pattern then paths, defaults to current dir
  rg: args => {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-t',
      '--type',
      '-T',
      '--type-not',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '--max-depth',
      '-r',
      '--replace',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return parsePatternCommand(args, flags, ['.'])
  },

  // sed: processes files in-place or reads from stdin
  sed: args => {
    const paths = []
    let skipNext = false
    let scriptFound = false
    // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
    // positional regardless of leading `-`. See filterOutFlags() doc comment.
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      if (skipNext) {
        skipNext = false
        continue
      }

      const arg = args[i]
      if (!arg) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      // Handle flags (only before `--`)
      if (!afterDoubleDash && arg.startsWith('-')) {
        // -f flag: next arg is a script file that needs validation
        if (['-f', '--file'].includes(arg)) {
          const scriptFile = args[i + 1]
          if (scriptFile) {
            paths.push(scriptFile) // Add script file to paths for validation
            skipNext = true
          }
          scriptFound = true
        }
        // -e flag: next arg is expression, not a file
        else if (['-e', '--expression'].includes(arg)) {
          skipNext = true
          scriptFound = true
        }
        // Combined flags like -ie or -nf
        else if (arg.includes('e') || arg.includes('f')) {
          scriptFound = true
        }
        continue
      }

      // First non-flag is the script (if not already found via -e/-f)
      if (!scriptFound) {
        scriptFound = true
        continue
      }

      // Rest are file paths
      paths.push(arg)
    }

    return paths
  },

  // jq: filter then file paths (similar to grep)
  // The jq command structure is: jq [flags] filter [files...]
  // If no files are provided, jq reads from stdin
  jq: args => {
    const paths = []
    const flagsWithArgs = new Set([
      '-e',
      '--expression',
      '-f',
      '--from-file',
      '--arg',
      '--argjson',
      '--slurpfile',
      '--rawfile',
      '--args',
      '--jsonargs',
      '-L',
      '--library-path',
      '--indent',
      '--tab',
    ])
    let filterFound = false
    // SECURITY: Track `--` end-of-options delimiter. After `--`, all args are
    // positional regardless of leading `-`. See filterOutFlags() doc comment.
    let afterDoubleDash = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (arg === undefined || arg === null) continue

      if (!afterDoubleDash && arg === '--') {
        afterDoubleDash = true
        continue
      }

      if (!afterDoubleDash && arg.startsWith('-')) {
        const flag = arg.split('=')[0]
        // Pattern flags mark that we've found the filter
        if (flag && ['-e', '--expression'].includes(flag)) {
          filterFound = true
        }
        // Skip next arg if flag needs it
        if (flag && flagsWithArgs.has(flag) && !arg.includes('=')) {
          i++
        }
        continue
      }

      // First non-flag is filter, rest are file paths
      if (!filterFound) {
        filterFound = true
        continue
      }
      paths.push(arg)
    }

    // If no file paths, jq reads from stdin (no paths to validate)
    return paths
  },

  // git: handle subcommands that access arbitrary files outside the repository
  git: args => {
    // git diff --no-index is special - it explicitly compares files outside git's control
    // This flag allows git diff to compare any two files on the filesystem, not just
    // files within the repository, which is why it needs path validation
    if (args.length >= 1 && args[0] === 'diff') {
      if (args.includes('--no-index')) {
        // SECURITY: git diff --no-index accepts `--` before file paths.
        // Use filterOutFlags which handles `--` correctly instead of naive
        // startsWith('-') filtering, to catch paths like `-/../etc/passwd`.
        const filePaths = filterOutFlags(args.slice(1))
        return filePaths.slice(0, 2) // git diff --no-index expects exactly 2 paths
      }
    }
    // Other git commands (add, rm, mv, show, etc.) operate within the repository context
    // and are already constrained by git's own security model, so they don't need
    // additional path validation
    return []
  },
}

const COMMAND_VALIDATOR = {
  mv: (args) => !args.some(arg => arg?.startsWith('-')),
  cp: (args) => !args.some(arg => arg?.startsWith('-')),
}

export { COMMAND_VALIDATOR };

export const COMMAND_OPERATION_TYPE = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}
