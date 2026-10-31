/* Old 2.1.88 CLI source: fsOperations.ts + permissions/filesystem.ts
 * + permissions/pathValidation.ts + utils/path.ts.
 * Methods remain source-named. Production entry only exposes READ path
 * validation; missing Read(path) and internal grants fail closed.
 * Writes, edits and redirects MUST stay on approval path until old
 * safety/checkEditableInternalPath/sandbox machinery is fully ported.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {dirname,isAbsolute,join,normalize,relative,resolve,posix,sep} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {getRuleByContentsForToolName,getDenyRules} from './permission-rules.js';
import ignore from './vendor/ignore.cjs';
const getFsImplementation=()=>fs;
const getCwd=()=>process.cwd();
// Pinned 2.1.88 platform semantics: WSL is distinct from regular Linux
// because DrvFs paths can expose NTFS alternate data streams (path:stream).
export function classifyOriginalPlatform(platform, procVersion='') {
  if(platform==='darwin')return 'macos';
  if(platform==='win32')return 'windows';
  if(platform==='linux') {
    const version=String(procVersion??'').toLowerCase();
    return version.includes('microsoft')||version.includes('wsl')?'wsl':'linux';
  }
  return 'unknown';
}

let cachedPlatform;
const getPlatform=()=>{
  if(cachedPlatform!==undefined)return cachedPlatform;
  try {
    let procVersion='';
    if(process.platform==='linux') {
      try {
        procVersion=getFsImplementation().readFileSync('/proc/version',{encoding:'utf8'});
      } catch {
        // The pinned source treats an unreadable /proc/version as regular Linux.
      }
    }
    cachedPlatform=classifyOriginalPlatform(process.platform,procVersion);
  } catch {
    cachedPlatform='unknown';
  }
  return cachedPlatform;
};
const getResolvedWorkingDirPaths=(path)=>getPathsForPermissionCheck(path);
// 2.1.88 windowsPaths.ts path conversion bodies (memoization removed only).
const windowsPathToPosixPath=(windowsPath)=>{
  if(windowsPath.startsWith('\\\\'))return windowsPath.replace(/\\/g,'/');
  const match=windowsPath.match(/^([A-Za-z]):[/\\]/);
  if(match)return '/'+match[1].toLowerCase()+windowsPath.slice(2).replace(/\\/g,'/');
  return windowsPath.replace(/\\/g,'/');
};
const posixPathToWindowsPath=(posixPath)=>{
  if(posixPath.startsWith('//'))return posixPath.replace(/\//g,'\\');
  const cyg=posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
  if(cyg){const rest=posixPath.slice(('/cygdrive/'+cyg[1]).length);return cyg[1].toUpperCase()+':'+(rest||'\\').replace(/\//g,'\\');}
  const drive=posixPath.match(/^\/([A-Za-z])(\/|$)/);
  if(drive)return drive[1].toUpperCase()+':'+posixPath.slice(2).replace(/\//g,'\\');
  return posixPath.replace(/\//g,'\\');
};
// Original 2.1.88 filesystem.ts protection closure (names and bodies retained).
// Additional CLI source locations are NOT available here; original
// isClaudeSettingsPath() always blocks canonical .claude settings paths,
// while directory protection covers other .claude files. Never synthesize
// a settings-specific automatic edit exemption.
const getSettingsPaths=()=>[];
const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
]

/**
 * Dangerous directories that should be protected from auto-editing.
 * These directories contain sensitive configuration or executable files.
 */
const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.claude',
]



function isClaudeSettingsPath(filePath) {
  // SECURITY: Normalize path structure first to prevent bypass via redundant ./
  // sequences like `./.claude/./settings.json` which would evade the endsWith() check
  const expandedPath = expandPath(filePath)

  // Normalize for case-insensitive comparison to prevent bypassing security
  // with paths like .cLauDe/Settings.locaL.json
  const normalizedPath = normalizeCaseForComparison(expandedPath)

  // Use platform separator so endsWith checks work on both Unix (/) and Windows (\)
  if (
    normalizedPath.endsWith(`${sep}.claude${sep}settings.json`) ||
    normalizedPath.endsWith(`${sep}.claude${sep}settings.local.json`)
  ) {
    // Include .claude/settings.json even for other projects
    return true
  }
  // Check for current project's settings files (including managed settings and CLI args)
  // Both paths are now absolute and normalized for consistent comparison
  return getSettingsPaths().some(
    settingsPath => normalizeCaseForComparison(settingsPath) === normalizedPath,
  )
}

function isClaudeConfigFilePath(filePath,cwd) {
  if (isClaudeSettingsPath(filePath)) {
    return true
  }

  // Check if file is within .claude/commands or .claude/agents directories
  // using proper path segment validation (not string matching with includes())
  // pathInWorkingPath now handles case-insensitive comparison to prevent bypasses
  const commandsDir = join(cwd, '.claude', 'commands')
  const agentsDir = join(cwd, '.claude', 'agents')
  const skillsDir = join(cwd, '.claude', 'skills')

  return (
    pathInWorkingPath(filePath, commandsDir) ||
    pathInWorkingPath(filePath, agentsDir) ||
    pathInWorkingPath(filePath, skillsDir)
  )
}

function isDangerousFilePathToAutoEdit(path) {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  // Check for UNC paths (defense-in-depth to catch any patterns that might not be caught by containsVulnerableUncPath)
  // Block anything starting with \\ or // as these are potentially UNC paths that could access network resources
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  // Check if path is within dangerous directories (case-insensitive to prevent bypasses)
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      // Special case: .claude/worktrees/ is a structural path (where Claude stores
      // git worktrees), not a user-created dangerous directory. Skip the .claude
      // segment when it's followed by 'worktrees'. Any nested .claude directories
      // within the worktree (not followed by 'worktrees') are still blocked.
      if (dir === '.claude') {
        const nextSegment = pathSegments[i + 1]
        if (
          nextSegment &&
          normalizeCaseForComparison(nextSegment) === 'worktrees'
        ) {
          break // Skip this .claude, continue checking other segments
        }
      }

      return true
    }
  }

  // Check for dangerous configuration files (case-insensitive)
  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName)
    if (
      DANGEROUS_FILES.some(
        dangerousFile =>
          normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true
    }
  }

  return false
}

function isOriginalNtNamespacePath(path) {
  return /^[\\/]\?\?[\\/]/.test(path) ||
    (path.includes('??') &&
      /^[\\/]\?\?[\\/]/.test(nodePath.win32.normalize(path)));
}

function isOriginalUntrustedAutomountPath(path) {
  if (!path.startsWith('/')) return false;
  const segments = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const first = segments[0] ?? '';
  return first.toLowerCase() === 'net' ||
    /^\.(?:vol|file|nofollow|resolve)$/i.test(first);
}

// 2.1.304 chunk-66cwftn5.js:oR(..., true), without the source's
// trustedNetworkDirectories exemption (the headless CLI has no such
// configured roots, so every untrusted network spelling remains blocked).
function hasOriginalUntrustedWindowsNetworkSpelling(path, platform) {
  if (platform !== 'windows') return false;
  const patterns = [
    /\\\\[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
    /(?:^|[^A-Za-z0-9_])[\\/]\?\?(?:[\\/]|$)/,
    /(?<!:)\/\/[^ \t\r\n\f\v\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
    /(?<![:\w])\/\\{1,}[^ \t\r\n\f\v\\/]+[\\/]/,
    /(?<![:\w])\\{1,}\/[^ \t\r\n\f\v\\/]+[\\/]/,
    /@SSL@\d+/i,
    /@\d+@SSL/i,
    /DavWWWRoot/i,
    /^\\\\(?:\d{1,3}\.){3}\d{1,3}[\\/]/,
    /^\/\/(?:\d{1,3}\.){3}\d{1,3}[\\/]/,
    /^\\\\\[[\da-fA-F:]+\][\\/]/,
    /^\/\/\[[\da-fA-F:]+\][\\/]/,
  ];
  return patterns.some(pattern => pattern.test(path));
}

export function hasSuspiciousWindowsPathPattern(path, platform=getPlatform()) {
  // 2.1.304 classifySuspiciousWindowsPathPattern() first rejects NT device
  // namespace paths, including single-leading-separator \??\ spellings.
  if (isOriginalNtNamespacePath(path)) return true;

  // NTFS Alternate Data Streams are interpreted by Windows and WSL DrvFs.
  if ((platform === 'windows' || platform === 'wsl') &&
      path.indexOf(':', 2) !== -1) return true;

  // DOS 8.3 aliases and long/device path prefixes.
  if (/~\d/.test(path)) return true;
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) return true;

  // 2.1.304 checks every path component, not only the final path spelling.
  for (const segment of path.split(/[/\\]/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (/[.\s]+$/.test(segment)) return true;
  }

  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) return true;
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) return true;

  // 2.1.304 additionally rejects untrusted /net and macOS special-volume
  // roots, plus embedded NT/WebDAV/UNC spellings. The CLI has no trusted
  // network-directory configuration, so these remain fail-closed.
  if (isOriginalUntrustedAutomountPath(path)) return true;
  if (hasOriginalUntrustedWindowsNetworkSpelling(path, platform)) return true;

  // Original 2.1.88 defense-in-depth UNC check remains active on all hosts.
  if (containsVulnerableUncPath(path)) return true;
  return false;
}

function checkPathSafetyForAutoEdit(path,precomputedPathsToCheck,cwd) {
  // Get all paths to check (original + symlink resolved paths)
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // Check for suspicious Windows path patterns on all paths
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        classifierApprovable: false,
      }
    }
  }

  // Check for Claude config files on all paths
  for (const pathToCheck of pathsToCheck) {
    if (isClaudeConfigFilePath(pathToCheck,cwd)) {
      return {
        safe: false,
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        classifierApprovable: true,
      }
    }
  }

  // Check for dangerous files on all paths
  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: `Claude requested permissions to edit ${path} which is a sensitive file.`,
        classifierApprovable: true,
      }
    }
  }

  // All safety checks passed
  return { safe: true }
}

// CLI presently rejects Read(path) rules and does not expose generic
// Claude internal-path or sandbox grants. Never synthesize grants here.
const DIR_SEP=posix.sep;
const FILE_READ_TOOL_NAME='Read';
const FILE_EDIT_TOOL_NAME='Edit';
// Original fsOperations/filesystem.ts source functions; path source roots use
// explicit --cwd instead of bootstrap.getOriginalCwd or getCwd globals.
function rootPathForSource(source, context) {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
      return expandPath(context.__cliWorkspace)
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      throw new Error('Settings-root scoped filesystem rules are not wired to CLI settings: '+source)
  }
}

function prependDirSep(path) {
  return posix.join(DIR_SEP, path)
}

function patternWithRoot(
  pattern,
  source,
  context,
) {
  if (pattern.startsWith(`${DIR_SEP}${DIR_SEP}`)) {
    // Patterns starting with // resolve relative to /
    const patternWithoutDoubleSlash = pattern.slice(1)

    // On Windows, check if this is a POSIX-style drive path like //c/Users/...
    // Note: UNC paths (//server/share) will not match this regex and will be treated
    // as root-relative patterns, which may need separate handling in the future
    if (
      getPlatform() === 'windows' &&
      patternWithoutDoubleSlash.match(/^\/[a-z]\//i)
    ) {
      // Convert POSIX path to Windows format
      // The pattern is like /c/Users/... so we convert it to C:\Users\...
      const driveLetter = patternWithoutDoubleSlash[1]?.toUpperCase() ?? 'C'
      // Keep the pattern in POSIX format since relativePath returns POSIX paths
      const pathAfterDrive = patternWithoutDoubleSlash.slice(2)

      // Extract the drive root (C:\) and the rest of the pattern
      const driveRoot = `${driveLetter}:\\`
      const relativeFromDrive = pathAfterDrive.startsWith('/')
        ? pathAfterDrive.slice(1)
        : pathAfterDrive

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      }
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: DIR_SEP,
    }
  } else if (pattern.startsWith(`~${DIR_SEP}`)) {
    // Patterns starting with ~/ resolve relative to homedir
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  } else if (pattern.startsWith(DIR_SEP)) {
    // Patterns starting with / resolve relative to the directory where settings are stored (without .claude/)
    return {
      relativePattern: pattern,
      root: rootPathForSource(source,context),
    }
  }
  // No root specified, put it with all the other patterns
  // Normalize patterns that start with "./" to remove the prefix
  // This ensures that patterns like "./.env" match files like ".env"
  let normalizedPattern = pattern
  if (pattern.startsWith(`.${DIR_SEP}`)) {
    normalizedPattern = pattern.slice(2)
  }
  return {
    relativePattern: normalizedPattern,
    root: null,
  }
}

function getPatternsByRoot(
  toolPermissionContext,
  toolType,
  behavior,
) {
  const toolName = (() => {
    switch (toolType) {
      case 'edit':
        // Apply Edit tool rules to any tool editing files
        return FILE_EDIT_TOOL_NAME
      case 'read':
        // Apply Read tool rules to any tool reading files
        return FILE_READ_TOOL_NAME
    }
  })()

  const rules = getRuleByContentsForToolName(
    toolPermissionContext,
    toolName,
    behavior,
  )
  // Resolve rules relative to path based on source
  const patternsByRoot = new Map()
  for (const [pattern, rule] of rules.entries()) {
    const { relativePattern, root } = patternWithRoot(pattern, rule.source,toolPermissionContext)
    let patternsForRoot = patternsByRoot.get(root)
    if (patternsForRoot === undefined) {
      patternsForRoot = new Map()
      patternsByRoot.set(root, patternsForRoot)
    }
    // Store the rule keyed by the root
    patternsForRoot.set(relativePattern, rule)
  }
  return patternsByRoot
}

function matchingRuleForInput(
  path,
  toolPermissionContext,
  toolType,
  behavior,
) {
  let fileAbsolutePath = expandPath(path,toolPermissionContext.__cliWorkspace)

  // On Windows, convert to POSIX format to match against permission patterns
  if (getPlatform() === 'windows' && fileAbsolutePath.includes('\\')) {
    fileAbsolutePath = windowsPathToPosixPath(fileAbsolutePath)
  }

  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    toolType,
    behavior,
  )

  // Check each root for a matching pattern
  for (const [root, patternMap] of patternsByRoot.entries()) {
    // Transform patterns for the ignore library
    const patterns = Array.from(patternMap.keys()).map(pattern => {
      let adjustedPattern = pattern

      // Remove /** suffix - ignore library treats 'path' as matching both
      // the path itself and everything inside it
      if (adjustedPattern.endsWith('/**')) {
        adjustedPattern = adjustedPattern.slice(0, -3)
      }

      return adjustedPattern
    })

    const ig = ignore().add(patterns)

    // Use cross-platform relative path helper for POSIX-style patterns
    const relativePathStr = relativePath(
      root ?? toolPermissionContext.__cliWorkspace,
      fileAbsolutePath ?? toolPermissionContext.__cliWorkspace,
    )

    if (relativePathStr.startsWith(`..${DIR_SEP}`)) {
      // The path is outside the root, so ignore it
      continue
    }

    // Important: ig.test throws if you give it an empty string
    if (!relativePathStr) {
      continue
    }

    const igResult = ig.test(relativePathStr)

    if (igResult.ignored && igResult.rule) {
      // Map the matched pattern back to the original rule
      const originalPattern = igResult.rule.pattern

      // Check if this was a /** pattern we simplified
      const withWildcard = originalPattern + '/**'
      if (patternMap.has(withWildcard)) {
        return patternMap.get(withWildcard) ?? null
      }

      return patternMap.get(originalPattern) ?? null
    }
  }

  // No matching rule found
  return null
}
import {checkReadableInternalPath,checkEditableInternalPath} from './original-internal-paths.js';

const isPathInSandboxWriteAllowlist=()=>false;
const containsVulnerableUncPath=(path)=>path.startsWith('\\\\')||path.startsWith('//');
const GLOB_PATTERN_REGEX=/[*?[\]{}]/;
function safeResolvePath(
  fs,
  filePath,
) {
  // Block UNC paths before any filesystem access to prevent network
  // requests (DNS/SMB) during validation on Windows
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }

  try {
    // Check for special file types (FIFOs, sockets, devices) before calling realpathSync.
    // realpathSync can block on FIFOs waiting for a writer, causing hangs.
    // If the file doesn't exist, lstatSync throws ENOENT which the catch
    // below handles by returning the original path (allows file creation).
    const stats = fs.lstatSync(filePath)
    if (
      stats.isFIFO() ||
      stats.isSocket() ||
      stats.isCharacterDevice() ||
      stats.isBlockDevice()
    ) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }

    const resolvedPath = fs.realpathSync(filePath)
    return {
      resolvedPath,
      isSymlink: resolvedPath !== filePath,
      // realpathSync returned: resolvedPath is canonical (all symlinks in
      // all path components resolved). Callers can skip further symlink
      // resolution on this path.
      isCanonical: true,
    }
  } catch (_error) {
    // If lstat/realpath fails for any reason (ENOENT, broken symlink,
    // EACCES, ELOOP, etc.), return the original path to allow operations
    // to proceed
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

function resolveDeepestExistingAncestorSync(
  fs,
  absolutePath,
) {
  let dir = absolutePath
  const segments = []
  // Walk up using lstat (cheap, O(1)) to find the first existing component.
  // lstat does not follow symlinks, so dangling symlinks are detected here.
  // Only call realpathSync (expensive, O(depth)) once at the end.
  while (dir !== nodePath.dirname(dir)) {
    let st
    try {
      st = fs.lstatSync(dir)
    } catch {
      // lstat failed: truly non-existent. Walk up.
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    if (st.isSymbolicLink()) {
      // Found a symlink (live or dangling). Try realpath first (resolves
      // chained symlinks); fall back to readlink for dangling symlinks.
      try {
        const resolved = fs.realpathSync(dir)
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      } catch {
        // Dangling: realpath failed but lstat saw the link entry.
        const target = fs.readlinkSync(dir)
        const absTarget = nodePath.isAbsolute(target)
          ? target
          : nodePath.resolve(nodePath.dirname(dir), target)
        return segments.length === 0
          ? absTarget
          : nodePath.join(absTarget, ...segments)
      }
    }
    // Existing non-symlink component. One realpath call resolves any
    // symlinks in its ancestors. If none, return undefined (no symlink).
    try {
      const resolved = fs.realpathSync(dir)
      if (resolved !== dir) {
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      }
    } catch {
      // realpath can still fail (e.g. EACCES in ancestors). Return
      // undefined — we can't resolve, and the logical path is already
      // in pathSet for the caller.
    }
    return undefined
  }
  return undefined
}

function getPathsForPermissionCheck(inputPath) {
  // Expand tilde notation defensively - tools should do this in getPath(),
  // but we normalize here as defense in depth for permission checking
  let path = inputPath
  if (path === '~') {
    path = homedir().normalize('NFC')
  } else if (path.startsWith('~/')) {
    path = nodePath.join(homedir().normalize('NFC'), path.slice(2))
  }

  const pathSet = new Set()
  const fsImpl = getFsImplementation()

  // Always check the original path
  pathSet.add(path)

  // Block UNC paths before any filesystem access to prevent network
  // requests (DNS/SMB) during validation on Windows
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    return Array.from(pathSet)
  }

  // Follow the symlink chain, collecting ALL intermediate targets
  // This handles cases like: test.txt -> /etc/passwd -> /private/etc/passwd
  // We want to check all three paths, not just test.txt and /private/etc/passwd
  try {
    let currentPath = path
    const visited = new Set()
    const maxDepth = 40 // Prevent runaway loops, matches typical SYMLOOP_MAX

    for (let depth = 0; depth < maxDepth; depth++) {
      // Prevent infinite loops from circular symlinks
      if (visited.has(currentPath)) {
        break
      }
      visited.add(currentPath)

      if (!fsImpl.existsSync(currentPath)) {
        // Path doesn't exist (new file case). existsSync follows symlinks,
        // so this is also reached for DANGLING symlinks (link entry exists,
        // target doesn't). Resolve symlinks in the path and its ancestors
        // so permission checks see the real destination. Without this,
        // `./data -> /etc/cron.d/` (live parent symlink) or
        // `./evil.txt -> ~/.ssh/authorized_keys2` (dangling file symlink)
        // would allow writes that escape the working directory.
        if (currentPath === path) {
          const resolved = resolveDeepestExistingAncestorSync(fsImpl, path)
          if (resolved !== undefined) {
            pathSet.add(resolved)
          }
        }
        break
      }

      const stats = fsImpl.lstatSync(currentPath)

      // Skip special file types that can cause issues
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break
      }

      if (!stats.isSymbolicLink()) {
        break
      }

      // Get the immediate symlink target
      const target = fsImpl.readlinkSync(currentPath)

      // If target is relative, resolve it relative to the symlink's directory
      const absoluteTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.resolve(nodePath.dirname(currentPath), target)

      // Add this intermediate target to the set
      pathSet.add(absoluteTarget)
      currentPath = absoluteTarget
    }
  } catch {
    // If anything fails during chain traversal, continue with what we have
  }

  // Also add the final resolved path using realpathSync for completeness
  // This handles any remaining symlinks in directory components
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, path)
  if (isSymlink && resolvedPath !== path) {
    pathSet.add(resolvedPath)
  }

  return Array.from(pathSet)
}

function normalizeCaseForComparison(path) {
  return path.toLowerCase()
}

function relativePath(from, to) {
  if (getPlatform() === 'windows') {
    // Convert Windows paths to POSIX for consistent comparison
    const posixFrom = windowsPathToPosixPath(from)
    const posixTo = windowsPathToPosixPath(to)
    return posix.relative(posixFrom, posixTo)
  }
  // Use POSIX paths directly
  return posix.relative(from, to)
}

function allWorkingDirectories(
  context,
) {
  return new Set([
    context.__cliWorkspace,
    ...context.additionalWorkingDirectories.keys(),
  ])
}

function pathInAllowedWorkingPath(
  path,
  toolPermissionContext,
  precomputedPathsToCheck,
) {
  // Check both the original path and the resolved symlink path
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // Resolve working directories the same way we resolve input paths so
  // comparisons are symmetric. Without this, a resolved input path
  // (e.g. /System/Volumes/Data/home/... on macOS) would not match an
  // unresolved working directory (/home/...), causing false denials.
  const workingPaths = Array.from(
    allWorkingDirectories(toolPermissionContext),
  ).flatMap(wp => getResolvedWorkingDirPaths(wp))

  // All paths must be within allowed working paths
  // If any resolved path is outside, deny access
  return pathsToCheck.every(pathToCheck =>
    workingPaths.some(workingPath =>
      pathInWorkingPath(pathToCheck, workingPath),
    ),
  )
}

function pathInWorkingPath(path, workingPath) {
  const absolutePath = expandPath(path)
  const absoluteWorkingPath = expandPath(workingPath)

  // On macOS, handle common symlink issues:
  // - /var -> /private/var
  // - /tmp -> /private/tmp
  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')

  // Normalize case for case-insensitive comparison to prevent bypassing security
  // checks on case-insensitive filesystems (macOS/Windows) like .cLauDe/CoMmAnDs
  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(
    normalizedWorkingPath,
  )

  // Use cross-platform relative path helper
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  // Same path
  if (relative === '') {
    return true
  }

  if (containsPathTraversal(relative)) {
    return false
  }

  // Path is inside (relative path that doesn't go up)
  return !posix.isAbsolute(relative)
}

function expandPath(path, baseDir) {
  // Set default baseDir to getCwd() if not provided
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  // Input validation
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof path}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(
      `Base directory must be a string, received ${typeof actualBaseDir}`,
    )
  }

  // Security: Check for null bytes
  if (path.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  // Handle empty or whitespace-only paths
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize('NFC')
  }

  // Handle home directory notation
  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  // On Windows, convert POSIX-style paths (e.g., /c/Users/...) to Windows format
  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      // If conversion fails, use original path
      processedPath = trimmedPath
    }
  }

  // Handle absolute paths
  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize('NFC')
  }

  // Handle relative paths
  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

function containsPathTraversal(path) {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

// Pinned source permissions/pathValidation.ts: MAX_DIRS_TO_LIST
const MAX_DIRS_TO_LIST = 5;
function formatDirectoryList(directories) {
  const dirCount = directories.length

  if (dirCount <= MAX_DIRS_TO_LIST) {
    return directories.map(dir => `'${dir}'`).join(', ')
  }

  const firstDirs = directories
    .slice(0, MAX_DIRS_TO_LIST)
    .map(dir => `'${dir}'`)
    .join(', ')

  return `${firstDirs}, and ${dirCount - MAX_DIRS_TO_LIST} more`
}

function getGlobBaseDirectory(path) {
  const globMatch = path.match(GLOB_PATTERN_REGEX)
  if (!globMatch || globMatch.index === undefined) {
    return path
  }

  // Get everything before the first glob character
  const beforeGlob = path.substring(0, globMatch.index)

  // Find the last directory separator
  const lastSepIndex =
    getPlatform() === 'windows'
      ? Math.max(beforeGlob.lastIndexOf('/'), beforeGlob.lastIndexOf('\\'))
      : beforeGlob.lastIndexOf('/')
  if (lastSepIndex === -1) return '.'

  return beforeGlob.substring(0, lastSepIndex) || '/'
}

function expandTilde(path) {
  if (
    path === '~' ||
    path.startsWith('~/') ||
    (process.platform === 'win32' && path.startsWith('~\\'))
  ) {
    return homedir() + path.slice(1)
  }
  return path
}

function isPathAllowed(
  resolvedPath,
  context,
  operationType,
  precomputedPathsToCheck,
) {
  // Determine which permission type to check based on operation
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  // 1. Check deny rules first (they take precedence)
  const denyRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'deny',
  )
  if (denyRule !== null) {
    return {
      allowed: false,
      decisionReason: { type: 'rule', rule: denyRule },
    }
  }

  // 2. For write/create operations, check internal editable paths (plan files, scratchpad, agent memory, job dirs)
  // This MUST come before checkPathSafetyForAutoEdit since .claude is a dangerous directory
  // and internal editable paths live under ~/.claude/ — matching the ordering in
  // checkWritePermissionForTool (filesystem.ts step 1.5)
  if (operationType !== 'read') {
    const internalEditResult = checkEditableInternalPath(resolvedPath, {})
    if (internalEditResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalEditResult.decisionReason,
      }
    }
  }

  // 2.5. For write/create operations, check comprehensive safety validations
  // This MUST come before checking working directory to prevent bypass via acceptEdits mode
  // Checks: Windows patterns, Claude config files, dangerous files (on original + symlink paths)
  if (operationType !== 'read') {
    // The CLI adapter still invokes the complete original safety method,
    // but prevalidates the actual --cwd and symlink aliases. On Windows the
    // trusted RUNNER~1 prefix is removed solely for suspicious-name matching;
    // the user-controlled suffix and canonical targets are untouched.
    const originalSafety=context.__cliWorkspace
      ? checkOriginalWritePathSafety(resolvedPath,context.__cliWorkspace,context)
      : null;
    const safetyCheck=originalSafety
      ? originalSafety.behavior==='passthrough' ? {safe:true} : {
          safe:false,
          message:originalSafety.reason,
          classifierApprovable:originalSafety.decisionReason?.classifierApprovable??false,
        }
      : checkPathSafetyForAutoEdit(resolvedPath,precomputedPathsToCheck);
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
          classifierApprovable: safetyCheck.classifierApprovable,
        },
      }
    }
  }

  // 3. Check if path is in allowed working directory
  // For write/create operations, require acceptEdits mode to auto-allow
  // This is consistent with checkWritePermissionForTool in filesystem.ts
  const isInWorkingDir = pathInAllowedWorkingPath(
    resolvedPath,
    context,
    precomputedPathsToCheck,
  )
  if (isInWorkingDir) {
    if (operationType === 'read' || context.mode === 'acceptEdits') {
      return { allowed: true }
    }
    // Write/create without acceptEdits mode falls through to check allow rules
  }

  // 3.5. For read operations, check internal readable paths (project temp dir, session memory, etc.)
  // This allows reading agent output files without explicit permission
  if (operationType === 'read') {
    const internalReadResult = checkReadableInternalPath(resolvedPath, {})
    if (internalReadResult.behavior === 'allow') {
      return {
        allowed: true,
        decisionReason: internalReadResult.decisionReason,
      }
    }
  }

  // 3.7. For write/create operations to paths OUTSIDE the working directory,
  // check the sandbox write allowlist. When the sandbox is enabled, users
  // have explicitly configured writable directories (e.g. /tmp/claude/) —
  // treat these as additional allowed write directories so redirects/touch/
  // mkdir don't prompt unnecessarily. Safety checks (step 2) already ran.
  // Paths IN the working directory are intentionally excluded: the sandbox
  // allowlist always seeds '.' (cwd, see sandbox-adapter.ts), which would
  // bypass the acceptEdits gate at step 3. Step 3 handles those.
  if (
    operationType !== 'read' &&
    !isInWorkingDir &&
    isPathInSandboxWriteAllowlist(resolvedPath)
  ) {
    return {
      allowed: true,
      decisionReason: {
        type: 'other',
        reason: 'Path is in sandbox write allowlist',
      },
    }
  }

  // 4. Check allow rules for the operation type
  const allowRule = matchingRuleForInput(
    resolvedPath,
    context,
    permissionType,
    'allow',
  )
  if (allowRule !== null) {
    return {
      allowed: true,
      decisionReason: { type: 'rule', rule: allowRule },
    }
  }

  // 5. Path is not allowed
  return { allowed: false }
}

function validateGlobPattern(
  cleanPath,
  cwd,
  toolPermissionContext,
  operationType,
) {
  if (containsPathTraversal(cleanPath)) {
    // For patterns with path traversal, resolve the full path
    const absolutePath = isAbsolute(cleanPath)
      ? cleanPath
      : resolve(cwd, cleanPath)
    const { resolvedPath, isCanonical } = safeResolvePath(
      getFsImplementation(),
      absolutePath,
    )
    const result = isPathAllowed(
      resolvedPath,
      toolPermissionContext,
      operationType,
      isCanonical ? [resolvedPath] : undefined,
    )
    return {
      allowed: result.allowed,
      resolvedPath,
      decisionReason: result.decisionReason,
    }
  }

  const basePath = getGlobBaseDirectory(cleanPath)
  const absoluteBasePath = isAbsolute(basePath)
    ? basePath
    : resolve(cwd, basePath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absoluteBasePath,
  )
  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

function validatePath(
  path,
  cwd,
  toolPermissionContext,
  operationType,
) {
  // Remove surrounding quotes if present
  const cleanPath = expandTilde(path.replace(/^['"]|['"]$/g, ''))

  // SECURITY: Block UNC paths that could leak credentials
  if (containsVulnerableUncPath(cleanPath)) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'UNC network paths require manual approval',
      },
    }
  }

  // SECURITY: Reject tilde variants (~user, ~+, ~-, ~N) that expandTilde doesn't handle.
  // expandTilde resolves ~ and ~/ to $HOME, but ~root, ~+, ~- etc. are left as literal
  // text and resolved as relative paths (e.g., /cwd/~root/.ssh/id_rsa).
  // The shell expands these differently (~root → /var/root, ~+ → $PWD, ~- → $OLDPWD),
  // creating a TOCTOU gap: we validate /cwd/~root/... but bash reads /var/root/...
  // This check is safe from false positives because expandTilde already converted
  // ~ and ~/ to absolute paths starting with /, so only unexpanded variants remain.
  if (cleanPath.startsWith('~')) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason:
          'Tilde expansion variants (~user, ~+, ~-) in paths require manual approval',
      },
    }
  }

  // SECURITY: Reject paths containing ANY shell expansion syntax ($ or % characters,
  // or paths starting with = which triggers Zsh equals expansion)
  // - $VAR (Unix/Linux environment variables like $HOME, $PWD)
  // - ${VAR} (brace expansion)
  // - $(cmd) (command substitution)
  // - %VAR% (Windows environment variables like %TEMP%, %USERPROFILE%)
  // - Nested combinations like $(echo $HOME)
  // - =cmd (Zsh equals expansion, e.g. =rg expands to /usr/bin/rg)
  // All of these are preserved as literal strings during validation but expanded
  // by the shell during execution, creating a TOCTOU vulnerability
  if (
    cleanPath.includes('$') ||
    cleanPath.includes('%') ||
    cleanPath.startsWith('=')
  ) {
    return {
      allowed: false,
      resolvedPath: cleanPath,
      decisionReason: {
        type: 'other',
        reason: 'Shell expansion syntax in paths requires manual approval',
      },
    }
  }

  // SECURITY: Block glob patterns in write/create operations
  // Write tools don't expand globs - they use paths literally.
  // Allowing globs in write operations could bypass security checks.
  // Example: /allowed/dir/*.txt would only validate /allowed/dir,
  // but the actual write would use the literal path with the *
  if (GLOB_PATTERN_REGEX.test(cleanPath)) {
    if (operationType === 'write' || operationType === 'create') {
      return {
        allowed: false,
        resolvedPath: cleanPath,
        decisionReason: {
          type: 'other',
          reason:
            'Glob patterns are not allowed in write operations. Please specify an exact file path.',
        },
      }
    }

    // For read operations, validate the base directory where the glob would expand
    return validateGlobPattern(
      cleanPath,
      cwd,
      toolPermissionContext,
      operationType,
    )
  }

  // Resolve path
  const absolutePath = isAbsolute(cleanPath)
    ? cleanPath
    : resolve(cwd, cleanPath)
  const { resolvedPath, isCanonical } = safeResolvePath(
    getFsImplementation(),
    absolutePath,
  )

  const result = isPathAllowed(
    resolvedPath,
    toolPermissionContext,
    operationType,
    isCanonical ? [resolvedPath] : undefined,
  )
  return {
    allowed: result.allowed,
    resolvedPath,
    decisionReason: result.decisionReason,
  }
}

/** Source validatePath READ-only adapter for the supported headless CLI.
 * Reject unsupported write operations before their source permission code.
 */
// Original 2.1.88 filesystem.ts:checkReadPermissionForTool() steps 1-2.
// Read paths need the same UNC and suspicious Windows-name checks as writes:
// NTFS ADS, 8.3 aliases, trailing dots/spaces, DOS device names and
// ambiguous three-dot path components. Keep a trusted Windows 8.3 workspace
// prefix out of the user-controlled suffix check, matching the write adapter.
function findTrustedWindowsShortPrefix(cwd,canonicalRoots){
  const cwdParts=cwd.replace(/\//g,'\\').split('\\');
  for(const root of canonicalRoots){
    const rootParts=root.replace(/\//g,'\\').split('\\');
    const limit=Math.min(cwdParts.length,rootParts.length);
    for(let i=0;i<limit;i++){
      if(!/~\d/.test(cwdParts[i]) ||
         cwdParts[i].toLowerCase()===rootParts[i].toLowerCase())continue;
      const prefixMatches=cwdParts.slice(0,i).every((part,index)=>
        part.toLowerCase()===rootParts[index]?.toLowerCase());
      if(!prefixMatches || !rootParts[i] || /~\d/.test(rootParts[i]))continue;
      return {
        shortPrefix:cwdParts.slice(0,i+1).join('\\').replace(/\\+$/,''),
        canonicalPrefix:rootParts.slice(0,i+1).join('\\').replace(/\\+$/,''),
      };
    }
  }
  return null;
}

function replaceTrustedWindowsShortPrefix(path,mapping){
  const normalized=path.replace(/\//g,'\\');
  const prefix=mapping.shortPrefix;
  const lower=normalized.toLowerCase();
  const lowerPrefix=prefix.toLowerCase();
  if(lower===lowerPrefix)return mapping.canonicalPrefix;
  if(lower.startsWith(lowerPrefix+'\\'))
    return mapping.canonicalPrefix+normalized.slice(prefix.length);
  return path;
}

function getTrustedWindowsTempPrefixMappings(cwd){
  const nativeRoot=tmpdir();
  if(!/~\d/.test(nativeRoot))return [];
  const roots=[nativeRoot,expandPath(nativeRoot,cwd)];
  const mappings=[];
  for(const root of roots){
    if(!/~\d/.test(root))continue;
    const canonicalRoots=getPathsForPermissionCheck(root);
    const mapping=findTrustedWindowsShortPrefix(root,canonicalRoots)??{
      shortPrefix:root.replace(/\//g,'\\').replace(/\\+$/,''),
      canonicalPrefix:join(nodePath.parse(root).root,'__agent_cil_verified_temp__'),
    };
    if(!mappings.some(existing=>existing.shortPrefix.toLowerCase()===mapping.shortPrefix.toLowerCase()))
      mappings.push(mapping);
  }
  return mappings.sort((a,b)=>b.shortPrefix.length-a.shortPrefix.length);
}

// 2.1.304 xN() fails closed when its path ancestry cannot be vetted.
// The original adapter's getPathsForPermissionCheck() intentionally returns
// partial aliases after some filesystem errors; keep that legacy helper for
// rule matching, but independently prove that every existing ancestor and
// symlink hop can be inspected before treating a Read path as safe.
function vetOriginalReadPathAncestry(path,platform=getPlatform()){
  const paths=new Set([path]);
  const visitedSymlinks=new Set();
  let pending=nodePath.resolve(path);
  let symlinkHops=0;
  for(;;){
    const root=nodePath.parse(pending).root;
    const segments=pending.slice(root.length).split(nodePath.sep).filter(Boolean);
    let current=root;
    let redirected=false;
    for(let i=0;i<segments.length;i++){
      const candidate=nodePath.join(current,segments[i]);
      let stats;
      try{
        stats=fs.lstatSync(candidate);
      }catch(error){
        if(error?.code==='ENOENT'){
          let realParent;
          try{realParent=fs.realpathSync(current)}catch{
            return {vetted:false,reason:'unreadable_ancestry',paths:[...paths]};
          }
          const suffix=segments.slice(i).join(nodePath.sep);
          const landing=nodePath.resolve(realParent,suffix);
          paths.add(realParent);
          paths.add(landing);
          return {vetted:true,paths:[...paths]};
        }
        return {vetted:false,reason:error?.code??'lstat_failed',paths:[...paths]};
      }
      if(stats.isSymbolicLink()){
        const key=platform==='windows'?candidate.toLowerCase():candidate;
        if(visitedSymlinks.has(key)||++symlinkHops>8){
          return {vetted:false,reason:'symlink_chain_unresolved',paths:[...paths]};
        }
        visitedSymlinks.add(key);
        let linkText;
        try{linkText=fs.readlinkSync(candidate)}catch(error){
          return {vetted:false,reason:error?.code??'readlink_failed',paths:[...paths]};
        }
        const target=nodePath.isAbsolute(linkText)
          ?nodePath.resolve(linkText)
          :nodePath.resolve(nodePath.dirname(candidate),linkText);
        paths.add(candidate);
        paths.add(target);
        pending=nodePath.resolve(target,...segments.slice(i+1));
        redirected=true;
        break;
      }
      current=candidate;
    }
    if(redirected)continue;
    try{
      const canonical=fs.realpathSync(pending);
      paths.add(canonical);
      return {vetted:true,paths:[...paths]};
    }catch(error){
      if(error?.code==='ENOENT'){
        const parent=nodePath.dirname(pending);
        try{
          const realParent=fs.realpathSync(parent);
          paths.add(realParent);
          paths.add(nodePath.resolve(realParent,nodePath.basename(pending)));
          return {vetted:true,paths:[...paths]};
        }catch{}
      }
      return {vetted:false,reason:error?.code??'realpath_failed',paths:[...paths]};
    }
  }
}

export function checkOriginalReadPathSafety(path,cwd,permissionContext={},platform=getPlatform()){
  if(typeof path!=='string'||!path.trim()||typeof cwd!=='string'){
    return {behavior:'ask',message:'Original Read path safety requires a valid path and workspace',
      decisionReason:{type:'other',reason:'Invalid original Read path'}};
  }
  try{
    // Preserve the source's pre-filesystem UNC check. POSIX normalize()
    // collapses a leading // to / and would otherwise erase this signal.
    if(path.startsWith('\\\\')||path.startsWith('//')){
      return {behavior:'ask',
        message:'Claude requested permissions to read from '+path+', which appears to be a UNC path that could access network resources.',
        decisionReason:{type:'other',reason:'UNC path detected (defense-in-depth check)'}};
    }

    // 2.1.304 xN() runs suspicious-spelling checks before walking user paths.
    // Resolve only process-owned roots first so a verified RUNNER~1 prefix
    // can be normalized without probing an attacker-supplied network path.
    const windowsPlatform=platform==='windows';
    const cwdHasShortPrefix=windowsPlatform && /~\d/.test(cwd);
    const cwdRoots=cwdHasShortPrefix?getPathsForPermissionCheck(cwd):[];
    const cwdMapping=cwdHasShortPrefix
      ?findTrustedWindowsShortPrefix(cwd,cwdRoots):null;
    const tempMappings=windowsPlatform?getTrustedWindowsTempPrefixMappings(cwd):[];
    const mappings=[
      ...(cwdMapping?[cwdMapping]:[]),
      ...tempMappings,
    ].sort((a,b)=>b.shortPrefix.length-a.shortPrefix.length);

    let spellingInput=path;
    if(windowsPlatform &&
       (/^\/[a-z]\//i.test(spellingInput) ||
        /^\/cygdrive\/[a-z](?:\/|$)/i.test(spellingInput))){
      // Bash/Node may surface the same Windows temp path as an MSYS /c/... or
      // /cygdrive/c/... spelling. Convert only drive-root forms, preserving
      // the remaining path text for the suspicious-component scan.
      try{spellingInput=posixPathToWindowsPath(spellingInput)}catch{}
    }
    for(const mapping of mappings)
      spellingInput=replaceTrustedWindowsShortPrefix(spellingInput,mapping);

    // When realpath cannot map the process cwd's short-name segment, only
    // strip that exact literal prefix from an absolute path spelling. The
    // subsequent alias/workspace check below must still prove confinement.
    if(cwdHasShortPrefix && !cwdMapping){
      const inputWindows=path.replace(/\//g,'\\');
      const rootSpellings=[cwd,...cwdRoots]
        .map(root=>root.replace(/\//g,'\\').replace(/\\+$/,''))
        .sort((a,b)=>b.length-a.length);
      for(const root of rootSpellings){
        const lowerInput=inputWindows.toLowerCase();
        const lowerRoot=root.toLowerCase();
        if(lowerInput===lowerRoot){spellingInput='';break;}
        if(lowerInput.startsWith(lowerRoot+'\\')){
          spellingInput=inputWindows.slice(root.length+1);
          break;
        }
      }
    }

    if(hasSuspiciousWindowsPathPattern(spellingInput,platform)){
      return {behavior:'ask',
        message:'Claude requested permissions to read from '+path+', which contains a suspicious Windows path pattern that requires manual approval.',
        decisionReason:{type:'other',reason:'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, trailing dots or spaces, device names, network or automount paths, or three or more consecutive dots) that require manual verification'}};
    }

    const raw=expandPath(path,cwd);
    const ancestry=vetOriginalReadPathAncestry(raw,platform);
    if(!ancestry.vetted){
      return {behavior:'ask',
        message:'Claude requested permissions to read from '+path+', but its path ancestry could not be safely verified.',
        decisionReason:{type:'other',reason:'Unvettable read path ancestry ('+ancestry.reason+') requires manual approval'}};
    }
    const aliases=Array.from(new Set([
      ...getPathsForPermissionCheck(raw),
      ...ancestry.paths,
    ]));
    for(const alias of aliases){
      if(alias.startsWith('\\\\')||alias.startsWith('//')){
        return {behavior:'ask',
          message:'Claude requested permissions to read from '+path+', which appears to be a UNC path that could access network resources.',
          decisionReason:{type:'other',reason:'UNC path detected (defense-in-depth check)'}};
      }
    }

    let checkedAliases=aliases.map(alias=>{
      let checked=alias;
      for(const mapping of mappings)
        checked=replaceTrustedWindowsShortPrefix(checked,mapping);
      return checked;
    });
    const context={...permissionContext,__cliWorkspace:cwd};

    if(cwdHasShortPrefix && !cwdMapping){
      // A separately authenticated TaskOutput tree may be outside the
      // workspace but under the OS-owned temp root. Normalize its trusted
      // temp prefix only; authorization still comes from the task identity
      // and session-bound internal-path checker.
      const rawWindows=raw.replace(/\//g,'\\').toLowerCase();
      const underTrustedTemp=tempMappings.some(mapping=>{
        const prefix=mapping.shortPrefix.toLowerCase();
        return rawWindows===prefix || rawWindows.startsWith(prefix+'\\');
      });
      if(!underTrustedTemp){
        if(!pathInAllowedWorkingPath(raw,context,aliases)){
          return {behavior:'ask',message:'Read path target or a resolved symlink escapes the trusted Windows workspace',
            decisionReason:{type:'other',reason:'Read path is outside the trusted workspace'}};
        }
        const neutralRoot=join(nodePath.parse(cwd).root,'__agent_cil_verified_workspace__');
        checkedAliases=[];
        for(const alias of aliases){
          // A DOS 8.3 spelling may compare as contained by both its short
          // lexical root and its long realpath root. Choose a root that yields
          // a genuinely relative, non-parent traversal suffix; never project
          // an alias through a root that would leave and re-enter the tree.
          const candidates=cwdRoots
            .map(root=>({root,suffix:relative(root,alias)}))
            .filter(({root,suffix})=>
              pathInWorkingPath(alias,root) &&
              suffix!== '..' &&
              !suffix.startsWith('..'+sep) &&
              !isAbsolute(suffix))
            .sort((a,b)=>a.suffix.length-b.suffix.length);
          const matching=candidates[0];
          if(!matching){
            return {behavior:'ask',message:'Unmapped Windows symlink read path target requires manual approval',
              decisionReason:{type:'other',reason:'Unmapped symlink read path target'}};
          }
          checkedAliases.push(join(neutralRoot,matching.suffix));
        }
      }
    }

    // Every resolved spelling is checked too, including symlink targets.
    for(const alias of checkedAliases){
      if(hasSuspiciousWindowsPathPattern(alias,platform)){
        return {behavior:'ask',
          message:'Claude requested permissions to read from '+path+', which contains a suspicious Windows path pattern that requires manual approval.',
          decisionReason:{type:'other',reason:'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, trailing dots or spaces, device names, network or automount paths, or three or more consecutive dots) that require manual verification'}};
      }
    }
    return {behavior:'passthrough'};
  }catch(error){
    return {behavior:'ask',
      message:'Original Read path safety could not be determined: '+String(error?.message??error),
      decisionReason:{type:'other',reason:'Original Read path safety failed closed'}};
  }
}

export function checkOriginalReadScopedRules(path,cwd,context){
  const safety=checkOriginalReadPathSafety(path,cwd,context);
  if(safety.behavior!=='passthrough')return safety;
  const toolPermissionContext={...context,__cliWorkspace:cwd};
  try{
    const pathsToCheck=getPathsForPermissionCheck(expandPath(path,cwd));
  // 3. Check for READ-SPECIFIC deny rules first - check both the original path and resolved symlink path
  // SECURITY: This must come before any allow checks (including "edit access implies read access")
  // to prevent bypassing explicit read deny rules
  for (const pathToCheck of pathsToCheck) {
  const denyRule = matchingRuleForInput(
  pathToCheck,
  toolPermissionContext,
  'read',
  'deny',
  )
  if (denyRule) {
  return {
    behavior: 'deny',
    message: `Permission to read ${path} has been denied.`,
    decisionReason: {
    type: 'rule',
    rule: denyRule,
    },
  }
  }
  }

  // 4. Check for READ-SPECIFIC ask rules - check both the original path and resolved symlink path
  // SECURITY: This must come before implicit allow checks to ensure explicit ask rules are honored
  for (const pathToCheck of pathsToCheck) {
  const askRule = matchingRuleForInput(
  pathToCheck,
  toolPermissionContext,
  'read',
  'ask',
  )
  if (askRule) {
  return {
    behavior: 'ask',
    message: `Claude requested permissions to read from ${path}, but you haven't granted it yet.`,
    decisionReason: {
    type: 'rule',
    rule: askRule,
    },
  }
  }
  }

    return {behavior:'passthrough'};
  }catch(error){
    return {behavior:'ask',message:'Original Read(path) rule resolution unavailable: '+String(error?.message??error),
      decisionReason:{type:'other',reason:'Scoped Read permission matcher failed closed'}};
  }
}

export function hasOriginalReadScopedRules(context){
  return ['deny','ask'].some(behavior=>
    getRuleByContentsForToolName(context,'Read',behavior).size>0);
}
export function hasOriginalReadDenyRules(context){
  // Match 2.1.304 chunk-4b60tdnk.js cge(): both whole-tool Read denies
  // and content-specific Read(path) denies fence unresolved post-cd reads.
  return getDenyRules(context).some(rule=>rule.ruleValue.toolName==='Read');
}
export function validateBashReadPath(path,cwd,permissionContext){
  // Source 2.1.88 checkReadPermissionForTool steps 3-4:
  // scoped Read deny, then ask, both over every symlink representation.
  const matched=checkOriginalReadScopedRules(path,cwd,permissionContext);
  if(matched.behavior!=='passthrough'){
    return {allowed:false,resolvedPath:String(path),decisionReason:matched.decisionReason?.type==='rule'
      ? matched.decisionReason : {type:'other',reason:matched.message}};
  }
  const scoped={...permissionContext,__cliWorkspace:cwd};
  try{
    const result=validatePath(path,cwd,scoped,'read');
    // Until CLI mounts original additionalWorkingDirectories and internal
    // read exceptions, scoped Read allow cannot escape the CLI --cwd boundary.
    if(result.allowed && !pathInAllowedWorkingPath(result.resolvedPath,scoped))
      return {allowed:false,resolvedPath:result.resolvedPath,decisionReason:{type:'other',reason:'File path outside CLI workspace'}};
    return result;
  }catch(error){
    return {allowed:false,resolvedPath:path,decisionReason:{type:'other',reason:'Original path resolution unavailable: '+String(error?.message??error)}};
  }
}
export {getPathsForPermissionCheck,safeResolvePath,pathInAllowedWorkingPath};

// 2.1.88 checkPathSafetyForAutoEdit() adapter for the current CLI cwd.
// This is an additional mandatory safety fence, not a generic write allow.
// Exact symlink-chain targets, workspace checks, Read rule checks and tool
// authorization are independent prerequisites to real execution.
export function checkOriginalWritePathSafety(path,cwd,permissionContext){
  if(typeof path!=='string'||!path.trim()||typeof cwd!=='string'){
    return {behavior:'ask',reason:'Original path safety requires a valid absolute or relative path'};
  }
  try{
    const raw=expandPath(path,cwd);
    const aliases=getPathsForPermissionCheck(raw);
    const context={...permissionContext,__cliWorkspace:cwd};
    // Always validate every original and symlink-resolved representation.
    // On Windows the OS may supply a trusted 8.3 *workspace prefix*
    // (GitHub Windows runners use C:\\Users\\RUNNER~1...). The original
    // hasSuspiciousWindowsPathPattern() deliberately checks every '~N'
    // component, so it would block EVERY ordinary edit on that runner.
    // Preserve the original source check unchanged for all user-controlled
    // target suffixes, but project only an already-trusted directory prefix
    // to a neutral volume-local root. This is not a bypass for arbitrary
    // paths: a link/target outside cwd or a sensitive workspace root is
    // rejected BEFORE the projection, while user suffixes remain verbatim.
    let checkedPath=raw,checkedAliases=aliases;
    if(getPlatform()==='windows' && /~\d/.test(cwd)){
      // The original symmetric workspace check accepts both native
      // RUNNER~1 and its realpath-resolved long-name representation.
      // Comparing every alias ONLY to the literal short cwd would
      // incorrectly reject already-verified canonical symlink targets.
      if(isDangerousFilePathToAutoEdit(cwd) ||
         !pathInAllowedWorkingPath(raw,context,aliases)){
        return {behavior:'ask',reason:'Trusted workspace root or a resolved write target is unsafe'};
      }
      const canonicalRoots=getPathsForPermissionCheck(cwd);
      const neutralRoot=join(nodePath.parse(cwd).root,'__agent_cil_verified_workspace__');
      checkedPath=join(neutralRoot,relative(cwd,raw));
      checkedAliases=[];
      for(const alias of aliases){
        const matchingRoot=canonicalRoots.find(root=>pathInWorkingPath(alias,root));
        if(!matchingRoot)return {behavior:'ask',reason:'Unmapped symlink write target requires manual approval'};
        checkedAliases.push(join(neutralRoot,relative(matchingRoot,alias)));
      }
    }
    const result=checkPathSafetyForAutoEdit(checkedPath,checkedAliases,cwd);
    if(!result.safe)return {
      behavior:'ask',reason:result.message,
      decisionReason:{type:'safetyCheck',reason:result.message,classifierApprovable:result.classifierApprovable},
    };
    if(!pathInAllowedWorkingPath(raw,context,aliases))return {
      behavior:'ask',reason:'Write target is outside allowed working directories',
      decisionReason:{type:'workingDir',reason:'Path outside allowed working directories'},
    };
    return {behavior:'passthrough'};
  }catch(error){
    return {behavior:'ask',reason:'Original write path safety could not be determined: '+String(error?.message??error),
      decisionReason:{type:'other',reason:'Original write path safety failed closed'}};
  }
}


// The following two bodies are copied directly from 2.1.88
// utils/permissions/filesystem.ts:checkWritePermissionForTool() steps 1 and 2.
// The wrapper supplies CLI --cwd and preserves original name/path matching.
function checkOriginalEditDenyRules(path, toolPermissionContext, precomputedPathsToCheck){
  // 1. Check for deny rules - check both the original path and resolved symlink path
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to edit ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }
  return {behavior:'passthrough'};
}
function checkOriginalEditAskRules(path, toolPermissionContext, pathsToCheck){
  // 2. Check for ask rules - check both the original path and resolved symlink path
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `Claude requested permissions to write to ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }
  return {behavior:'passthrough'};
}
export function checkOriginalEditScopedRules(path,cwd,permissionContext,behavior){
  if(!['deny','ask','allow'].includes(behavior))
    throw new TypeError('Original edit scope behavior must be deny, ask, or allow');
  if(typeof path!=='string'||!path.trim()||typeof cwd!=='string')
    return {behavior:'ask',message:'Original Edit path requires a valid target',
      decisionReason:{type:'other',reason:'Invalid scoped Edit path'}};
  try {
    const expanded=expandPath(path,cwd);
    const context={...permissionContext,__cliWorkspace:cwd};
    const pathsToCheck=getPathsForPermissionCheck(expanded);
    if(behavior==='deny')
      return checkOriginalEditDenyRules(expanded,context,pathsToCheck);
    if(behavior==='ask')
      return checkOriginalEditAskRules(expanded,context,pathsToCheck);
    // Original checkWritePermissionForTool step 4 evaluates allow against
    // input path, not just its symlink-resolved target. Any original safe-write
    // check and mandatory workspace check must already have passed first.
    const allowRule=matchingRuleForInput(expanded,context,'edit','allow');
    return allowRule
      ? {behavior:'allow',message:'Original Edit(path) allow rule matched',
          decisionReason:{type:'rule',rule:allowRule}}
      : {behavior:'passthrough'};
  }catch(error){
    return {behavior:'ask',message:'Original Edit(path) matcher failed: '+
      String(error?.message??error),
      decisionReason:{type:'other',reason:'Scoped Edit rule check failed closed'}};
  }
}
export function hasOriginalEditScopedRules(context){
  return ['deny','ask'].some(behavior=>
    getRuleByContentsForToolName(context,'Edit',behavior).size>0);
}


// BashTool/pathValidation.ts:validateOutputRedirections() uses source
// validatePath(target,cwd,permissionContext,'create') after AST extraction.
// Source isPathAllowed() honors Edit denial, acceptEdits, sandbox and scoped
// Edit allow. The CLI adapter intentionally has no global sandbox exception.
export function validateBashCreatePath(target,cwd,context){
  try{
    const scoped={...context,__cliWorkspace:cwd};
    const verified=validatePath(target,cwd,scoped,'create');
    if(!verified.allowed)return verified;
    // No outside-cwd allowance is implied by an Edit path rule in the
    // current CLI; physical workspace confinement still applies.
    if(!pathInAllowedWorkingPath(verified.resolvedPath,scoped))
      return {allowed:false,resolvedPath:verified.resolvedPath,
        decisionReason:{type:'workingDir',reason:'Output target outside authorized workspace'}};
    return verified;
  }catch(error){
    return {allowed:false,resolvedPath:String(target),
      decisionReason:{type:'other',reason:'Original create path validation failed: '+String(error?.message??error)}};
  }
}

export {expandPath as expandOriginalPath,windowsPathToPosixPath,allWorkingDirectories,formatDirectoryList};


// Direct source 2.1.88 filesystem.ts: getFileReadIgnorePatterns(),
// shared by original GrepTool/GlobTool and the native CLI search filter.
export function getFileReadIgnorePatterns(
  toolPermissionContext,
) {
  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    'read',
    'deny',
  )
  const result = new Map()
  for (const [patternRoot, patternMap] of patternsByRoot.entries()) {
    result.set(patternRoot, Array.from(patternMap.keys()))
  }

  return result
}
