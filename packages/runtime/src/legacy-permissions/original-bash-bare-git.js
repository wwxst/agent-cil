/** Original 2.1.88 utils/git.ts isCurrentDirectoryBareGitRepo:
 * source body unchanged except TypeScript type erasure and injection of
 * the real Bash workspace and Node statSync for the old getCwd/fs layer.
 * This utility does not by itself grant permissions.
 */
import {statSync} from 'node:fs';
import {join} from 'node:path';
export function isCurrentDirectoryBareGitRepo(cwd,fs={statSync}) {
  const gitPath = join(cwd, '.git')
  try {
    const stats = fs.statSync(gitPath)
    if (stats.isFile()) {
      // worktree/submodule — Git follows the gitdir reference
      return false
    }
    if (stats.isDirectory()) {
      const gitHeadPath = join(gitPath, 'HEAD')
      try {
        // SECURITY: check isFile(). An attacker creating .git/HEAD as a
        // DIRECTORY would pass a bare statSync but Git's setup_git_directory
        // rejects it (not a valid HEAD) and falls back to cwd discovery.
        if (fs.statSync(gitHeadPath).isFile()) {
          // normal repo — .git/HEAD valid, Git won't fall back to cwd
          return false
        }
        // .git/HEAD exists but is not a regular file — fall through
      } catch {
        // .git exists but no HEAD — fall through to bare-repo check
      }
    }
  } catch {
    // no .git — fall through to bare-repo indicator check
  }

  // No valid .git/HEAD found. Check if cwd has bare git repo indicators.
  // Be cautious — flag if ANY of these exist without a valid .git reference.
  // Per-indicator try/catch so an error on one doesn't mask another.
  try {
    if (fs.statSync(join(cwd, 'HEAD')).isFile()) return true
  } catch {
    // no HEAD
  }
  try {
    if (fs.statSync(join(cwd, 'objects')).isDirectory()) return true
  } catch {
    // no objects/
  }
  try {
    if (fs.statSync(join(cwd, 'refs')).isDirectory()) return true
  } catch {
    // no refs/
  }
  return false
}
