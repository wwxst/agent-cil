/**
 * User-owned original CLI 2.1.88 permissions/filesystem.ts:
 * checkEditableInternalPath() and checkReadableInternalPath() bodies.
 *
 * Original method names and decision objects are retained. The only
 * changes within those bodies are TS type erasure and guards for missing
 * CLI bootstrap services: plans, scratchpad feature gate, memory/memdir,
 * TEMPLATES jobs, desktop preview, swarms, bundled-skill nonce and global
 * Claude config roots MUST NOT be fabricated. Their absence is
 * passthrough, never an implicit directory allow.
 *
 * The one native provider currently backed by a real CLI session is
 * .agent-cil/sessions/<locked UUID>/tool-results; scope comes from the
 * actual locked SessionJournal, not model tool input or environment.
 */
import {normalize,join,resolve,sep,isAbsolute,relative} from 'node:path';
import {getPathsForPermissionCheck} from './original-bash-read-paths.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normalizeCaseForComparison=p=>p.toLowerCase();
const passthrough=()=>({behavior:'passthrough',message:''});
function within(path,root){
  const p=relative(root,path);
  return p===''||(!p.startsWith('..'+sep)&&p!=='..'&&!isAbsolute(p));
}
function trustedSessionStorage(workspace,sessionId){
  return typeof workspace==='string'&&isAbsolute(workspace)&&
    typeof sessionId==='string'&&UUID.test(sessionId);
}
export function makeOriginalInternalPathChecks({
  workspace,sessionId,verifiedCompletedTaskOutput,
}={}){
  // CLI sessions with --session-id have durable private tool-result
  // directories. Plain interactive/--print sessions may instead own an
  // ephemeral completed Bash TaskOutput with sessionId=null, authenticated
  // by the native completed-output inode registry.
  const workspaceTrusted=typeof workspace==='string'&&isAbsolute(workspace);
  const trusted=trustedSessionStorage(workspace,sessionId);
  const workspaceRoot=workspaceTrusted?resolve(workspace):null;
  const resultRoot=trusted?join(workspaceRoot,'.agent-cil','sessions',
    sessionId,'tool-results'):null;
  // Source helper names are kept local to the session-bound checker. No
  // global mutable "current session" that another CLI runner can replace.
  const feature=()=>false; // no original TEMPLATES bootstrap
  const isSessionPlanFile=()=>false; // no owned plan slug/plan service
  const isScratchpadPath=()=>false; // no feature-gated 0700 scratchpad service
  const isAgentMemoryPath=()=>false; // no Agent memory ownership service
  const hasAutoMemPathOverride=()=>true; // never auto grant an arbitrary override
  const isAutoMemPath=()=>false;
  const isSessionMemoryPath=()=>false; // no session-memory owner service
  const isProjectDirPath=()=>false; // no Claude project metadata grant
  const getClaudeConfigHomeDir=()=>null; // no verified Claude config owner
  const getOriginalCwd=()=>workspaceRoot;
  const isTrustedPreviewSession=()=>false; // CLI-only, no preview workflow
  const getToolResultsDir=()=>resultRoot;
  const getProjectTempDir=()=>null; // no broad /tmp/claude-{uid} allow
  const getBundledSkillsRoot=()=>null; // no generated per-process nonce
function checkEditableInternalPath(
  absolutePath,input) {
  // SECURITY: Normalize path to prevent traversal bypasses via .. segments
  // This is defense-in-depth; individual helper functions also normalize
  const normalizedPath = normalize(absolutePath)

  // Plan files for current session
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for writing',
      },
    }
  }

  // Scratchpad directory for current session
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for writing',
      },
    }
  }

  // Template job's own directory. Env key hardcoded (vs importing JOB_ENV_KEY
  // from jobs/state) so tree-shaking eliminates the string from external
  // builds — spawn.test.ts asserts the string matches. Hijack guard: the env
  // var value must itself resolve under ~/.claude/jobs/. Symlink guard: every
  // resolved form of the target (lexical + symlink chain) must fall under some
  // resolved form of the job dir, so a symlink inside the job dir pointing at
  // e.g. ~/.ssh/authorized_keys does not get a free write. Resolving both
  // sides handles the macOS /tmp → /private/tmp case where the config dir
  // lives under a symlinked root.
  if (feature('TEMPLATES')) {
    const jobDir = process.env.CLAUDE_JOB_DIR
    if (jobDir) {
      const jobsRoot = join(getClaudeConfigHomeDir(), 'jobs')
      const jobDirForms = getPathsForPermissionCheck(jobDir).map(normalize)
      const jobsRootForms = getPathsForPermissionCheck(jobsRoot).map(normalize)
      // Hijack guard: every resolved form of the job dir must sit under
      // some resolved form of the jobs root. Resolving both sides handles
      // the case where ~/.claude is a symlink (e.g. to /data/claude-config).
      const isUnderJobsRoot = jobDirForms.every(jd =>
        jobsRootForms.some(jr => jd.startsWith(jr + sep)),
      )
      if (isUnderJobsRoot) {
        const targetForms = getPathsForPermissionCheck(absolutePath)
        const allInsideJobDir = targetForms.every(p => {
          const np = normalize(p)
          return jobDirForms.some(jd => np === jd || np.startsWith(jd + sep))
        })
        if (allInsideJobDir) {
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionReason: {
              type: 'other',
              reason:
                'Job directory files for current job are allowed for writing',
            },
          }
        }
      }
    }
  }

  // Agent memory directory (for self-improving agents)
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for writing',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  // This pre-safety-check carve-out exists because the default path is under
  // ~/.claude/, which is in DANGEROUS_DIRECTORIES. The CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  // override is an arbitrary caller-designated directory with no such conflict,
  // so it gets NO special permission treatment here — writes go through normal
  // permission flow (step 5 → ask). SDK callers who want silent memory should
  // pass an allow rule for the override path.
  if (!hasAutoMemPathOverride() && isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for writing',
      },
    }
  }

  // .claude/launch.json — desktop preview config (dev server command + port).
  // The desktop's preview_start MCP tool instructs Claude to create/update
  // this file as part of the preview workflow. Without this carve-out the
  // .claude/ DANGEROUS_DIRECTORIES check prompts for it, which in SDK mode
  // cascades: user clicks "Always allow" → setMode:acceptEdits suggestion
  // applied → silent downgrade from auto mode. Matches the project-level
  // .claude/ only (not ~/.claude/) since launch.json is per-project.
  if (
    isTrustedPreviewSession() &&
    normalizeCaseForComparison(normalizedPath) ===
    normalizeCaseForComparison(join(getOriginalCwd(), '.claude', 'launch.json'))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Preview launch config is allowed for writing',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
function checkReadableInternalPath(
  absolutePath,input) {
  // SECURITY: Normalize path to prevent traversal bypasses via .. segments
  // This is defense-in-depth; individual helper functions also normalize
  const normalizedPath = normalize(absolutePath)

  // Session memory directory
  if (isSessionMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Session memory files are allowed for reading',
      },
    }
  }

  // Project directory (for reading past session memories)
  // Path format: ~/.claude/projects/{sanitized-cwd}/...
  if (isProjectDirPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project directory files are allowed for reading',
      },
    }
  }

  // Plan files for current session
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for reading',
      },
    }
  }

  // Tool results directory (persisted large outputs)
  // Use path separator suffix to prevent path traversal (e.g., tool-results-evil/)
  const toolResultsDir = getToolResultsDir()
  const toolResultsDirWithSep = toolResultsDir.endsWith(sep)
    ? toolResultsDir
    : toolResultsDir + sep
  if (
    toolResultsDir && (
      normalizedPath === toolResultsDir ||
      normalizedPath.startsWith(toolResultsDirWithSep)
    )
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Tool result files are allowed for reading',
      },
    }
  }

  // Scratchpad directory for current session
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for reading',
      },
    }
  }

  // Project temp directory (/tmp/claude/{sanitized-cwd}/)
  // Intentionally allows reading files from all sessions in this project, not just the current session.
  // This enables cross-session file access within the same project's temp space.
  const projectTempDir = getProjectTempDir()
  if (projectTempDir && normalizedPath.startsWith(projectTempDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project temp directory files are allowed for reading',
      },
    }
  }

  // Agent memory directory (for self-improving agents)
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for reading',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  if (isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for reading',
      },
    }
  }

  // Tasks directory (~/.claude/tasks/) for swarm task coordination
  const tasksDir = getClaudeConfigHomeDir()
    ? join(getClaudeConfigHomeDir(), 'tasks') + sep : ''
  if (
    tasksDir && (
      normalizedPath === tasksDir.slice(0, -1) ||
      normalizedPath.startsWith(tasksDir)
    )
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Task files are allowed for reading',
      },
    }
  }

  // Teams directory (~/.claude/teams/) for swarm coordination
  const teamsReadDir = getClaudeConfigHomeDir()
    ? join(getClaudeConfigHomeDir(), 'teams') + sep : ''
  if (
    teamsReadDir && (
      normalizedPath === teamsReadDir.slice(0, -1) ||
      normalizedPath.startsWith(teamsReadDir)
    )
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Team files are allowed for reading',
      },
    }
  }

  // Bundled skill reference files extracted on first invocation.
  // SECURITY: See getBundledSkillsRoot() — the per-process nonce in the path
  // is the load-bearing defense; uid/VERSION alone are public knowledge and
  // squattable. We always write-before-read on invocation, so content under
  // this subtree is harness-controlled.
  const bundledSkillsRoot = getBundledSkillsRoot()
    ? getBundledSkillsRoot() + sep : ''
  if (bundledSkillsRoot && normalizedPath.startsWith(bundledSkillsRoot)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Bundled skill reference files are allowed for reading',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
  function grantReadForSourceOwnedTaskOutput(path,input) {
    // Old source getProjectTempDir() allowed a broad subtree. The CLI
    // already has a stronger cap: only a *completed*, identity-verified
    // Bash output belonging to the active session, checked again on open.
    if(!workspaceTrusted || typeof verifiedCompletedTaskOutput!=='function' ||
       !verifiedCompletedTaskOutput(path))return passthrough();
    return {
      behavior:'allow',updatedInput:input,
      decisionReason:{type:'other',
        reason:'Verified current-session completed Bash task output is allowed for reading'},
    };
  }
  function checkRead(path,input={}) {
    if(typeof path!=='string'||!isAbsolute(path)||!workspaceTrusted)
      return passthrough();
    // The original helper works on normalized paths. Prevent symlink and
    // junction aliases from turning a path *inside* one session's result
    // directory into an internal grant for a different root.
    const normalized=normalize(path);
    if(getPathsForPermissionCheck(normalized).some(alias=>
      !within(alias,workspaceRoot))){
      // Original project-temp read exception maps only to *completed*
      // current-session Bash output, authenticated by the native
      // TaskOutput inode and committed task record, not a temp prefix.
      return grantReadForSourceOwnedTaskOutput(normalized,input);
    }
    const source=trusted
      ? checkReadableInternalPath(normalized,input) : passthrough();
    if(source.behavior==='allow'){
      // For tool-result internal grant, all symlink-resolved forms must
      // remain under the same verified session result directory.
      if(!getPathsForPermissionCheck(normalized).every(alias=>
        within(alias,resultRoot)))return passthrough();
      return source;
    }
    return grantReadForSourceOwnedTaskOutput(normalized,input);
  }
  function checkEdit(path,input={}) {
    if(typeof path!=='string'||!isAbsolute(path)||!trusted)
      return passthrough();
    // No original session plan/scratchpad/agent memory/preview provider is
    // available yet. Keep the source function in the real path but never
    // waive the source DANGEROUS_DIRECTORIES safety check by inference.
    return checkEditableInternalPath(normalize(path),input);
  }
  return {checkRead,checkEdit};
}
export function checkReadableInternalPath(path,input,context){
  return makeOriginalInternalPathChecks(context).checkRead(path,input);
}
export function checkEditableInternalPath(path,input,context){
  return makeOriginalInternalPathChecks(context).checkEdit(path,input);
}
