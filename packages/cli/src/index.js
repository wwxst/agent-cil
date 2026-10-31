#!/usr/bin/env node
import { stat, readdir, mkdir, realpath, lstat, open, readFile, unlink } from 'node:fs/promises';
import { constants, realpathSync, appendFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { killPosixProcessTree } from './kill-process-tree.js';
import { createLocalShellTaskManager } from './local-shell-task.js';
import {
  TaskOutput, isReadableInternalTaskOutputPath,
  openReadableInternalTaskOutput, restoreCompletedTaskOutputs,
} from './legacy-task-output.js';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getHelp, languageLabel, loadLanguagePreference, localizeCliMessage, normalizeLanguagePreference, resolveLanguage, saveLanguagePreference, translate as t } from './i18n.js';
import { applyPermissionUpdates } from '../../runtime/src/legacy-permissions/permission-update.js';
import { checkWholeToolPermissionRules } from '../../runtime/src/legacy-permissions/permission-rules.js';
import { permissionRuleValueFromString, permissionRuleValueToString } from '../../runtime/src/legacy-permissions/permission-rule-parser.js';
import { bashToolCheckExactMatchPermission } from '../../runtime/src/legacy-permissions/bash-exact-permission.js';
import { bashToolCheckAstPermission } from '../../runtime/src/legacy-permissions/bash-ast-permission.js';
import { resolveOriginalCliModel } from '../../runtime/src/legacy-original/model-aliases.js';
import { getOriginalCliAutoCompactThreshold, isEnvTruthy } from '../../runtime/src/legacy-compact/original-auto-compact-threshold.js';
import {
  getPerMessageBudgetLimit, generatePreview, buildLargeToolResultMessage,
  PREVIEW_SIZE_BYTES,
} from '../../runtime/src/legacy-tools/tool-result-storage.js';
import { checkOriginalReadScopedRules, hasOriginalReadScopedRules, checkOriginalWritePathSafety, checkOriginalEditScopedRules } from '../../runtime/src/legacy-permissions/original-bash-read-paths.js';
import {checkReadableInternalPath,checkEditableInternalPath} from '../../runtime/src/legacy-permissions/original-internal-paths.js';
import { rememberOriginalFileRead, checkOriginalFileReadState } from './original-file-read-state.js';
import { interpretCommandResult } from './original-bash-command-semantics.js';

const VERSION = '0.1.0';
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const MAX_WALK_FILES = 5000;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.agent-cil']);
const BACKSLASH = String.fromCharCode(92);
const REGEX_META = new Set(['.', '+', '^', '$', '(', ')', '|', '[', ']', '{', '}', BACKSLASH]);

export const HELP = getHelp('en', VERSION);

export class CliArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('argv must be an array of strings.');
  }
  if (argv.length === 1 && ['--version', '-v', '-V'].includes(argv[0])) {
    return { mode: 'version' };
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    let language;
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--') break;
      if (arg === '--language') {
        const raw = argv[i + 1];
        if (raw === undefined || raw.startsWith('--')) throw new CliArgumentError('--language requires a value.');
        language = normalizeLanguagePreference(raw);
        if (!language) throw new CliArgumentError('Language must be auto, zh-CN, or en.');
        i += 1;
      } else if (arg.startsWith('--language=')) {
        language = normalizeLanguagePreference(arg.slice('--language='.length));
        if (!language) throw new CliArgumentError('Language must be auto, zh-CN, or en.');
      }
    }
    return language === undefined ? { mode: 'help' } : { mode: 'help', language };
  }

  const options = {
    mode: 'run',
    print: false,
    language: undefined,
    model: undefined,
    baseUrl: undefined,
    provider: 'anthropic',
    maxTokens: 4096,
    maxTurns: 8,
    compactThreshold: undefined,
    maxRetries: 2,
    allowEdits: false,
    permissionMode: undefined,
    permissionRules: { allow: [], deny: [], ask: [] },
    hooksFile: undefined,
    sessionId: undefined,
    resume: undefined,
    system: undefined,
    cwd: process.cwd(),
    positional: [],
  };

  const takeValue = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliArgumentError(name + ' requires a value.');
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--language' || arg.startsWith('--language=')) {
      const raw = arg === '--language' ? takeValue(arg, i++) : arg.slice('--language='.length);
      const language = normalizeLanguagePreference(raw);
      if (!language) throw new CliArgumentError('Language must be auto, zh-CN, or en.');
      options.language = language;
    } else if (arg === '--print' || arg === '-p') {
      options.print = true;
    } else if (arg === '--allow-edits') {
      options.allowEdits = true;
    } else if (arg === '--permission-mode' || arg.startsWith('--permission-mode=')) {
      const mode = arg === '--permission-mode' ? takeValue(arg, i++) : arg.slice('--permission-mode='.length);
      // Match the original PermissionMode / PermissionUpdate vocabulary.
      // This headless CLI intentionally does not expose bypassPermissions,
      // auto or dontAsk until the corresponding source security flow exists.
      if (!['default','acceptEdits','plan'].includes(mode)) {
        throw new CliArgumentError('--permission-mode must be default, acceptEdits, or plan.');
      }
      options.permissionMode = mode;
    } else if (['--allowedTools', '--disallowedTools', '--askTools'].some(
      flag => arg === flag || arg.startsWith(flag + '=')
    )) {
      const [flag, ...inlineValue] = arg.split('=');
      const behavior = flag === '--allowedTools' ? 'allow'
        : flag === '--disallowedTools' ? 'deny' : 'ask';
      const raw = inlineValue.length ? inlineValue.join('=') : takeValue(flag, i++);
      const parsed = permissionRuleValueFromString(raw);
      const wholeTool = parsed.ruleContent === undefined && raw === parsed.toolName;
      // The original Bash exact-command checkPermissions method is now
      // connected. Wildcard/prefix/compound rule matching still needs the
      // original bashPermissions.ts AST dependency closure, so reject such
      // rules instead of approximating them with a dangerous regex.
      const bashContent = parsed.toolName === 'Bash' &&
        typeof parsed.ruleContent === 'string' &&
        parsed.ruleContent.length > 0 &&
        parsed.ruleContent.trim() === parsed.ruleContent &&
        raw === permissionRuleValueToString(parsed);
      // Literal exact Bash allow remains narrowly permitted. Original
      // prefix/wildcard shell matching is connected for restrictive deny/ask
      // rules only: an unrestricted allow would require original AST checks.
      const bashRule = bashContent && (behavior !== 'allow' ||
        !parsed.ruleContent.includes('*'));
      // Old 2.1.88 Read(path) matcher is now active for Bash/Read.
      // Grep/Glob with scoped file restrictions remain approval-gated
      // until source per-file discovery filtering is connected.
      const readPathRule=parsed.toolName==='Read' &&
        typeof parsed.ruleContent==='string' &&
        parsed.ruleContent.length>0 &&
        raw===permissionRuleValueToString(parsed);
      // 2.1.88 filesystem.ts maps both Write and Edit file operations to
      // FILE_EDIT_TOOL_NAME='Edit' for scoped filesystem permission rules.
      const editPathRule=parsed.toolName==='Edit' &&
        typeof parsed.ruleContent==='string' &&
        parsed.ruleContent.length>0 &&
        raw===permissionRuleValueToString(parsed);
      if (!['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'].includes(parsed.toolName) ||
          !(wholeTool || bashRule || readPathRule || editPathRule)) {
        throw new CliArgumentError(flag +
          ' accepts whole built-in names, Bash(command), Read(path) or Edit(path);' +
          ' wildcard/prefix Bash allow, other content-specific rules and MCP require original security checks.');
      }
      options.permissionRules[behavior].push(parsed);
    } else if (arg === '--hooks-file' || arg.startsWith('--hooks-file=')) {
      options.hooksFile = arg === '--hooks-file' ? takeValue(arg, i++) : arg.slice('--hooks-file='.length);
      if (!options.hooksFile) throw new CliArgumentError('--hooks-file requires a path.');
    } else if (arg === '--session-id' || arg.startsWith('--session-id=') ||
               arg === '--resume' || arg.startsWith('--resume=')) {
      const flag = arg.split('=')[0];
      const id = arg === flag ? takeValue(flag, i++) : arg.slice(flag.length+1);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new CliArgumentError(flag + ' requires a valid UUID.');
      }
      if (flag === '--session-id') options.sessionId = id;
      else options.resume = id;
    } else if (arg === '--provider' || arg.startsWith('--provider=')) {
      const provider = arg === '--provider' ? takeValue(arg, i++) : arg.slice('--provider='.length);
      if (!['anthropic', 'deepseek', 'openai'].includes(provider)) {
        throw new CliArgumentError('--provider must be anthropic, deepseek, or openai.');
      }
      options.provider = provider;
    } else if (arg === '--model') {
      options.model = takeValue(arg, i++);
    } else if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length);
    } else if (arg === '--base-url') {
      options.baseUrl = takeValue(arg, i++);
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--max-tokens') {
      options.maxTokens = Number(takeValue(arg, i++));
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 200000) {
        throw new CliArgumentError('--max-tokens must be an integer between 1 and 200000.');
      }
    } else if (arg.startsWith('--max-tokens=')) {
      options.maxTokens = Number(arg.slice('--max-tokens='.length));
      if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > 200000) {
        throw new CliArgumentError('--max-tokens must be an integer between 1 and 200000.');
      }
    } else if (arg === '--max-turns' || arg.startsWith('--max-turns=')) {
      const raw = arg === '--max-turns' ? takeValue(arg, i++) : arg.slice('--max-turns='.length);
      options.maxTurns = Number(raw);
      if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 100) {
        throw new CliArgumentError('--max-turns must be an integer between 1 and 100.');
      }
    } else if (arg === '--compact-threshold' || arg.startsWith('--compact-threshold=')) {
      const raw = arg === '--compact-threshold' ? takeValue(arg, i++) : arg.slice('--compact-threshold='.length);
      options.compactThreshold = Number(raw);
      if (!Number.isSafeInteger(options.compactThreshold) ||
        options.compactThreshold < 0 || options.compactThreshold > 2000000) {
        throw new CliArgumentError('--compact-threshold must be an integer from 0 to 2000000.');
      }
    } else if (arg === '--max-retries' || arg.startsWith('--max-retries=')) {
      const raw = arg === '--max-retries' ? takeValue(arg, i++) : arg.slice('--max-retries='.length);
      options.maxRetries = Number(raw);
      if (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 5) {
        throw new CliArgumentError('--max-retries must be an integer between 0 and 5.');
      }
    } else if (arg === '--system') {
      options.system = takeValue(arg, i++);
    } else if (arg.startsWith('--system=')) {
      options.system = arg.slice('--system='.length);
    } else if (arg === '--cwd') {
      options.cwd = takeValue(arg, i++);
    } else if (arg.startsWith('--cwd=')) {
      options.cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('-')) {
      throw new CliArgumentError('Unknown option: ' + arg);
    } else {
      options.positional.push(arg);
    }
  }

  if (options.allowEdits && options.permissionMode !== undefined &&
      options.permissionMode !== 'acceptEdits') {
    throw new CliArgumentError('--allow-edits cannot be combined with a different --permission-mode.');
  }
  options.permissionMode ??= options.allowEdits ? 'acceptEdits' : 'default';
  if (options.sessionId && options.resume) {
    throw new CliArgumentError('--session-id and --resume cannot be used together.');
  }
  options.cwd = resolve(options.cwd);
  options.prompt = options.positional.join(' ').trim();
  return options;
}

export function resolveWorkspacePath(workspace, candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new TypeError('file_path must be a non-empty string.');
  }
  const root = resolve(workspace);
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('Path escapes the workspace: ' + candidate);
  }
  return target;
}

async function assertPathWithinWorkspace(workspace, target) {
  try {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink()) throw new Error('Symbolic links are not allowed for file tools: ' + target);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
  }
  const rootReal = await realpath(workspace);
  let probe = target;
  while (true) {
    try {
      const resolvedProbe = await realpath(probe);
      const rel = relative(rootReal, resolvedProbe);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
        throw new Error('Path resolves outside the workspace: ' + target);
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        const parent = dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      } else {
        throw error;
      }
    }
  }
}


/**
 * Build the CLI's permission policy. File writes and edits are checked against
 * the workspace before prompting; the Runtime repeats this check if a policy
 * or approval handler changes the effective input.
 */
/**
 * The legacy 2.1.88 permission update operation is now the source of the
 * opt-in acceptEdits mode; no special-case bypass in the approval handler.
 * Additional rule persistence stays disabled until the original dependency
 * closure is runnable and independently verified.
 */
export function createCliPermissionContext({ allowEdits = false, permissionMode, permissionRules = {} } = {}) {
  const mode = permissionMode ?? (allowEdits ? 'acceptEdits' : 'default');
  if (!['default','acceptEdits','plan'].includes(mode) ||
      (allowEdits && mode !== 'acceptEdits')) {
    throw new TypeError('Unsupported or conflicting original CLI permission mode.');
  }
  // Reuse the original 2.1.88 PermissionUpdate setMode path rather than a
  // second allow/edit policy flag or a self-built permission engine.
  const updates = [{ type: 'setMode', destination: 'cliArg', mode }];
  for (const behavior of ['allow', 'deny', 'ask']) {
    const rules = permissionRules[behavior] || [];
    if (rules.length) updates.push({ type: 'addRules', destination: 'cliArg', behavior, rules });
  }
  return applyPermissionUpdates({
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: new Map(),
  }, updates);
}

export function createCliPermissionPolicy({
  workspace = process.cwd(),
  permissionContext = createCliPermissionContext(),
  sessionId = null,
  taskManager = null,
} = {}) {
  const root = resolve(workspace);
  const policy = async ({ name, input } = {}) => {
    // Original 2.1.88 BashTool.isReadOnly() is reached after the mature
    // security/AST/path/redirection chain; the previous temporary CLI
    // blanket-deny for plan mode was a divergence. Reuse that source
    // read-only decision, never user-supplied Bash allow, Hook allow or
    // acceptEdits to authorize a mutating operation in plan mode.
    // Background shells are process mutations, even when stdout-only.
    if(permissionContext.mode==='plan' && name==='Bash'){
      if(input?.run_in_background===true)
        return {behavior:'deny',reason:'Plan mode does not authorize background Bash processes.'};
      const readonly=await bashToolCheckAstPermission(input,permissionContext,{
        workspace:root,readOnlyOnly:true,
      });
      if(readonly.behavior==='allow')
        return {behavior:'allow',reason:'Original 2.1.88 read-only Bash command',
          decisionReason:readonly.decisionReason};
      return {behavior:'deny',reason:'Plan mode does not authorize Bash commands unless the original AST, path and read-only checks all allow them: '+
        (readonly.message??'not source-validated read-only')};
    }
    // Writes and task termination remain barred in plan mode regardless
    // of a whole-tool allow rule or PreToolUse Hook permissionDecision.
    if(permissionContext.mode==='plan' &&
       ['Write','Edit','TaskStop'].includes(name)) {
      return {behavior:'deny',reason:'Plan mode does not authorize workspace or process mutations.'};
    }
    if (name === 'Glob') {
      // 2.1.88 GlobTool.checkPermissions delegates to the original
      // checkReadPermissionForTool() on GlobTool.getPath() (cwd). The
      // source Grep/Glob runners also apply getFileReadIgnorePatterns()
      // to individual discovered paths. Do not blanket-ask for an
      // unrelated scoped Read deny under this workspace.
      const globWhole=checkWholeToolPermissionRules(permissionContext,{name});
      if(globWhole?.behavior==='deny')return globWhole;
      // Original checkReadPermissionForTool always checks UNC and suspicious
      // Windows path forms before any implicit workspace grant, even when no
      // scoped Read deny/ask rules are configured.
      const globReadSafety=checkOriginalReadScopedRules(root,root,permissionContext);
      if(globReadSafety.behavior!=='passthrough')return {
        behavior:globReadSafety.behavior,reason:globReadSafety.message,
        decisionReason:globReadSafety.decisionReason,
      };
      const pattern = typeof input?.pattern === 'string' ? input.pattern.replaceAll(BACKSLASH, '/') : '';
      if (!pattern || pattern.startsWith('/') || pattern.split('/').includes('..')) {
        return { behavior: 'deny', reason: 'Glob pattern must stay within the workspace.' };
      }
      return globWhole || { behavior: 'allow', reason: 'Read-only workspace search.' };
    }

    if (['Read', 'Write', 'Edit', 'Grep'].includes(name)) {
      const wholeToolRule=checkWholeToolPermissionRules(permissionContext,{name});
      // Original whole-tool deny wins before Read/Grep scoped fallback asks.
      // Write/Edit still run the mandatory workspace path check BEFORE
      // returning a whole-tool deny, preserving non-authorized-path reasons.
      if(wholeToolRule?.behavior==='deny' && (name==='Read'||name==='Grep'))
        return wholeToolRule;
      const candidate = name === 'Grep' ? (input?.path ?? '.') : input?.file_path;
      // Original GrepTool.getPath() is subject to checkReadPermissionForTool
      // BEFORE the original ripgrep file-level deny exclusions execute.
      if(name==='Grep'){
        // The source GrepTool.getPath() passes through the same mandatory
        // Read path safety checks as Read, independent of scoped rule count.
        const grepReadSafety=checkOriginalReadScopedRules(candidate,root,permissionContext);
        if(grepReadSafety.behavior!=='passthrough')return {
          behavior:grepReadSafety.behavior,reason:grepReadSafety.message,
          decisionReason:grepReadSafety.decisionReason,
        };
      }
      // Old 2.1.88 Read tool checked content rules before both workspace
      // implicit grants and whole-tool rules (checkReadPermissionForTool #3-4).
      if(name==='Read'){
        const scoped=checkOriginalReadScopedRules(candidate,root,permissionContext);
        if(scoped.behavior!=='passthrough')return {
          behavior:scoped.behavior,
          reason:scoped.message,
          decisionReason:scoped.decisionReason,
        };
      }
      // Legacy checkReadableInternalPath() can authorize project task
      // output files. Until session-specific task ownership is ported,
      // only an exact, completed in-process Bash output is permitted.
      // Explicit deny/ask tool rules still take precedence.
      if(name==='Read' && typeof candidate==='string' && isAbsolute(candidate)) {
        // 2.1.88 filesystem.ts:checkReadableInternalPath() is now the
        // internal-path permission entry point. Its only outside-workspace
        // native exception remains the *exact* session-owned completed
        // TaskOutput identity, not an arbitrary temp directory.
        const internal=checkReadableInternalPath(candidate,input,{
          workspace:root,sessionId,
          verifiedCompletedTaskOutput:exactPath=>
            isReadableInternalTaskOutputPath(root,exactPath,sessionId),
        });
        if(internal.behavior==='allow')
          return checkWholeToolPermissionRules(permissionContext,{name}) ||
            {behavior:'allow',reason:internal.decisionReason?.reason,
              decisionReason:internal.decisionReason};
      }
      try {
        const target = resolveWorkspacePath(root, candidate);
        await assertPathWithinWorkspace(root, target);
      } catch (error) {
        return {
          behavior: 'deny',
          reason: 'File target is not authorized: ' + (error instanceof Error ? error.message : String(error)),
        };
      }

      // 2.1.88 Edit/Write must run checkPathSafetyForAutoEdit() before
      // accepting acceptEdits or whole-tool allow. Its safetyCheck
      // result retains the ask behavior (manual review required).
      if(name==='Write'||name==='Edit'){
        if(wholeToolRule?.behavior==='deny')return wholeToolRule;
        // Original 2.1.88 filesystem.ts step 1: source-scoped Edit deny,
        // across path and all symlink aliases, even when Write is allowed.
        const editDeny=checkOriginalEditScopedRules(candidate,root,permissionContext,'deny');
        if(editDeny.behavior!=='passthrough')return {
          behavior:editDeny.behavior,reason:editDeny.message,
          decisionReason:editDeny.decisionReason,
        };
        // Original step 1.5: only session-owned internal paths may bypass
        // .claude safety. This CLI does not yet own plans/scratchpads/memory,
        // so missing providers intentionally fall through.
        const internalEdit=checkEditableInternalPath(typeof candidate==='string'?resolve(root,candidate):'',input,{
          workspace:root,sessionId,
        });
        if(internalEdit.behavior==='allow')
          return {behavior:'allow',reason:internalEdit.decisionReason?.reason,
            decisionReason:internalEdit.decisionReason};
        const editSafety=checkOriginalWritePathSafety(candidate,root,permissionContext);
        if(editSafety.behavior!=='passthrough')return editSafety;
        // Original step 2: scoped Edit ask precedes acceptEdits and any
        // whole-tool allow. Safety checks have already run.
        const editAsk=checkOriginalEditScopedRules(candidate,root,permissionContext,'ask');
        if(editAsk.behavior!=='passthrough')return {
          behavior:editAsk.behavior,reason:editAsk.message,
          decisionReason:editAsk.decisionReason,
        };
      }

      // Run original 2.1.88 whole-tool rules only AFTER the mandatory
      // workspace/symlink checks. An allow rule must never permit escape.
      if (wholeToolRule) return wholeToolRule;

      if (name === 'Read' || name === 'Grep') {
        return { behavior: 'allow', reason: 'Read-only workspace operation.' };
      }
      if(permissionContext.mode==='acceptEdits')
        return {behavior:'allow',reason:'Edits authorized by acceptEdits mode.'};
      // Original 2.1.88 filesystem.ts step 4: Edit(path) allow applies to
      // both native Write and Edit, but cannot bypass safety or outside cwd.
      const editAllow=checkOriginalEditScopedRules(candidate,root,permissionContext,'allow');
      if(editAllow.behavior!=='passthrough')return {
        behavior:editAllow.behavior,reason:editAllow.message,
        decisionReason:editAllow.decisionReason,
      };
      return {behavior:'ask',reason:'This tool modifies workspace files.'};
    }

    if (name === 'TaskOutput' || name === 'TaskStop') {
      const taskId=input?.task_id??input?.shell_id;
      if(!taskManager?.has(taskId) ||
          (name==='TaskStop' && taskManager.status(taskId)?.status!=='running'))
        return {behavior:'deny',reason:'No active owned Bash task with that ID.'};
      return checkWholeToolPermissionRules(permissionContext,{name}) ||
        {behavior:'allow',reason:'Operate on this CLI session-owned background Bash task.'};
    }
    if (name === 'Bash') {
      return checkWholeToolPermissionRules(permissionContext, { name }) ||
        { behavior: 'ask', reason: 'This command executes a shell process.',
          decisionReason: { type: 'mode', mode: 'default' } };
    }

    return { behavior: 'deny', reason: 'No CLI permission rule exists for tool ' + String(name) + '.' };
  };
  // This built-in policy makes its decision from tool identity, input and
  // the immutable workspace/rule context, never the evolving assistant text.
  // Custom policies do not receive this opt-in and are always deferred.
  Object.defineProperty(policy, 'supportsStreamingPreflight', { value: true });
  Object.defineProperty(policy, 'isBuiltinCliPolicy', { value: true });
  return policy;
}

async function walkFiles(start, state = { files: [], truncated: false }, signal, canReadPath) {
  if (signal?.aborted) throw abortError(signal);
  // The old GrepTool/GlobTool apply source getFileReadIgnorePatterns before
  // disclosing filenames/content. When descending the native bounded walker,
  // prune denied directories before readdir and denied files before any read.
  if(canReadPath && !canReadPath(start)) return state;
  if (state.files.length >= MAX_WALK_FILES) {
    state.truncated = true;
    return state;
  }
  const entries = await readdir(start, { withFileTypes: true });
  if (signal?.aborted) throw abortError(signal);
  for (const entry of entries) {
    if (signal?.aborted) throw abortError(signal);
    if (state.files.length >= MAX_WALK_FILES) {
      state.truncated = true;
      break;
    }
    if (entry.isSymbolicLink()) continue;
    const fullPath = join(start, entry.name);
    if(canReadPath && !canReadPath(fullPath))continue;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name))
        await walkFiles(fullPath, state, signal, canReadPath);
    } else if (entry.isFile()) {
      state.files.push(fullPath);
    }
  }
  // Conservatively report truncation at the cap: callers must not mistake a
  // bounded walk for an exhaustive search when the exact total is unknown.
  if (state.files.length >= MAX_WALK_FILES) state.truncated = true;
  return state;
}

function globToRegExp(pattern) {
  const normalized = pattern.replaceAll(BACKSLASH, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (REGEX_META.has(char)) {
      source += BACKSLASH + char;
    } else {
      source += char;
    }
  }
  const prefix = normalized.includes('/') ? '^' : '^(?:.*/)?';
  return new RegExp(prefix + source + '$');
}

async function assertOpenedFileWithinWorkspace(workspace, target, handle) {
  const rootReal = await realpath(workspace);
  const targetInfo = await lstat(target);
  if (targetInfo.isSymbolicLink()) {
    throw new Error('Symbolic links are not allowed for file tools: ' + target);
  }

  const resolvedTarget = await realpath(target);
  const rel = relative(rootReal, resolvedTarget);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('Path resolves outside the workspace: ' + target);
  }

  const [openedInfo, pathInfo] = await Promise.all([handle.stat(), stat(resolvedTarget)]);
  if (!openedInfo.isFile() || !pathInfo.isFile()) throw new Error('Not a regular file: ' + target);
  if (openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
    throw new Error('File path changed while opening; refusing the operation: ' + target);
  }
}

async function openWithNoFollow(target, flags, mode) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    return await open(target, flags | noFollow, mode);
  } catch (error) {
    // Some platforms expose O_NOFOLLOW in constants but do not implement it for open().
    // O_EXCL still protects create-if-absent operations when this fallback is needed.
    if (!noFollow || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    return open(target, flags, mode);
  }
}

async function openWorkspaceFile(workspace, target, flags, mode) {
  await assertPathWithinWorkspace(workspace, target);
  let openFlags = flags;
  if ((flags & constants.O_CREAT) !== 0) {
    try {
      await lstat(target);
      // Existing files must already exist at open time; don't silently recreate a
      // target that disappears after the check.
      openFlags &= ~constants.O_CREAT;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Atomic O_EXCL prevents a final-component symlink appearing after lstat()
      // from being followed to a target outside the workspace.
      openFlags |= constants.O_EXCL;
    }
  }

  const handle = await openWithNoFollow(target, openFlags, mode);
  try {
    await assertOpenedFileWithinWorkspace(workspace, target, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readTextHandle(handle, filePath, signal) {
  if (signal?.aborted) throw abortError(signal);
  const info = await handle.stat();
  if (signal?.aborted) throw abortError(signal);
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new Error('File exceeds the 1 MiB read limit: ' + filePath);
  }

  // Do not rely only on stat(): a concurrently growing file must not bypass the
  // text-read memory limit between the size check and the actual read.
  const chunks = [];
  let total = 0;
  while (total <= MAX_TEXT_FILE_BYTES) {
    if (signal?.aborted) throw abortError(signal);
    const length = Math.min(64 * 1024, MAX_TEXT_FILE_BYTES + 1 - total);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, total);
    if (signal?.aborted) throw abortError(signal);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_TEXT_FILE_BYTES) {
      throw new Error('File exceeds the 1 MiB read limit: ' + filePath);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  const content = Buffer.concat(chunks, total).toString('utf8');
  if (content.includes(String.fromCharCode(0))) throw new Error('Refusing to read a binary file as text: ' + filePath);
  return content;
}

/**
 * Read a bounded range of 0-based lines through the already-verified file
 * descriptor. Unlike the default whole-file read, this also permits selecting
 * a small section of a source file larger than the 1 MiB output cap.
 *
 * The Read offset/limit schema follows the released CLI 2.1.304 shape.
 * Bytes are scanned incrementally and never buffered beyond the output cap.
 */
async function readTextLinesHandle(handle, filePath, { offset = 0, limit = Infinity } = {}, signal) {
  if (signal?.aborted) throw abortError(signal);
  const info = await handle.stat();
  if (signal?.aborted) throw abortError(signal);
  if (!info.isFile()) throw new Error('Not a regular file: ' + filePath);
  const pieces = [];
  let outputBytes = 0;
  let byteOffset = 0;
  let lineIndex = 0;

  while (true) {
    if (signal?.aborted) throw abortError(signal);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
    if (signal?.aborted) throw abortError(signal);
    if (bytesRead === 0) break;
    byteOffset += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      if (signal?.aborted) throw abortError(signal);
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 || newline >= bytesRead ? bytesRead : newline + 1;
      if (lineIndex >= offset && lineIndex - offset < limit) {
        const part = buffer.subarray(start, end);
        if (part.includes(0)) {
          throw new Error('Refusing to read a binary file as text: ' + filePath);
        }
        outputBytes += part.length;
        if (outputBytes > MAX_TEXT_FILE_BYTES) {
          throw new Error('Selected lines exceed the 1 MiB read limit: ' + filePath);
        }
        pieces.push(part);
      }
      if (end <= start) throw new Error('Could not advance line reader.');
      start = end;
      if (newline >= 0 && newline < bytesRead) {
        lineIndex += 1;
        if (lineIndex >= offset + limit) {
          return Buffer.concat(pieces, outputBytes).toString('utf8');
        }
      }
    }
  }
  return Buffer.concat(pieces, outputBytes).toString('utf8');
}

async function readTextFile(workspace, filePath, options, signal) {
  if (signal?.aborted) throw abortError(signal);
  const handle = await openWorkspaceFile(workspace, filePath, constants.O_RDONLY);
  try {
    // Await the selected read before the finally block closes its file handle.
    if (signal?.aborted) throw abortError(signal);
    const value = options === undefined
      ? await readTextHandle(handle, filePath, signal)
      : await readTextLinesHandle(handle, filePath, options, signal);
    if (signal?.aborted) throw abortError(signal);
    return value;
  } finally {
    await handle.close();
  }
}

async function writeTextHandle(handle, content) {
  const buffer = Buffer.from(content, 'utf8');
  await handle.truncate(0);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (bytesWritten === 0) throw new Error('Could not complete file write.');
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Shell command was aborted.');
  error.name = 'AbortError';
  return error;
}

function makeProcessTreeCleanupError(message,cause) {
  const error=new Error(message,cause?{cause}:undefined);
  error.name='ProcessTreeCleanupError';
  return error;
}

function waitForChildExit(child,timeoutMs) {
  if(child.exitCode!==null || child.signalCode!==null)return Promise.resolve();
  return new Promise((resolveExit,rejectExit)=>{
    let settled=false;
    const cleanup=()=>{
      clearTimeout(timer);
      child.removeListener('exit',onExit);
    };
    const onExit=()=>{
      if(settled)return;
      settled=true;
      cleanup();
      resolveExit();
    };
    const timer=setTimeout(()=>{
      if(settled)return;
      settled=true;
      cleanup();
      rejectExit(new Error('Windows Bash supervisor did not exit after termination.'));
    },timeoutMs);
    child.once('exit',onExit);
    if(child.exitCode!==null || child.signalCode!==null)onExit();
  });
}

function resolveWindowsBashExecutable() {
  const candidates=[];
  const configured=process.env.CLAUDE_CODE_SHELL;
  if(configured && /(?:^|[\\/])bash(?:\.exe)?$/i.test(configured))
    candidates.push(configured);
  const shell=process.env.SHELL;
  if(shell && /bash(?:\.exe)?$/i.test(shell))
    candidates.push(shell);
  for(const rawDirectory of (process.env.PATH||'').split(';')) {
    const directory=rawDirectory.trim().replace(/^"(.*)"$/,'$1');
    if(!directory)continue;
    candidates.push(join(directory,'bash.exe'),join(directory,'bash'));
  }
  const seen=new Set();
  for(const candidate of candidates) {
    if(!candidate || seen.has(candidate))continue;
    seen.add(candidate);
    try {
      if(existsSync(candidate))return resolve(candidate);
    } catch {}
  }
  throw new Error(
    'Windows Bash requires a POSIX bash.exe. Install Git for Windows or another Bash distribution, '+
    'ensure bash.exe is on PATH, or set CLAUDE_CODE_SHELL to its full path.');
}

async function createWindowsJobSupervisor(command,cwd) {
  const id=randomUUID().replaceAll('-','');
  const commandEnvironmentName='AGENT_CIL_'+id+'_COMMAND';
  const cwdEnvironmentName='AGENT_CIL_'+id+'_CWD';
  const statusEnvironmentName='AGENT_CIL_'+id+'_STATUS';
  const shellEnvironmentName='AGENT_CIL_'+id+'_SHELL';
  const shellPath=resolveWindowsBashExecutable();
  const pipeName='agent-cil-'+process.pid+'-'+id;
  const pipePath='\\\\.\\pipe\\'+pipeName;
  const statusPath=join(tmpdir(),'agent-cil-winjob-'+id+'.json');
  const stagePath=statusPath+'.stage';
  const nodeStagePath=stagePath+'.node';
  const server=createNetServer();
  const owner={
    commandEnvironmentName,cwdEnvironmentName,statusEnvironmentName,shellEnvironmentName,shellPath,
    pipeName,pipePath,statusPath,stagePath,nodeStagePath,server,socket:null,buffer:'',
    ready:false,done:false,killed:false,shellExitCode:null,failure:null,
    childExited:false,statusPromise:null,socketCloseTimer:null,
    pendingKill:null,killPromise:null,closed:false,
  };
  let resolveReady,rejectReady,resolveDone,rejectDone;
  owner.readyPromise=new Promise((resolve,reject)=>{
    resolveReady=resolve;rejectReady=reject;
  });
  owner.donePromise=new Promise((resolve,reject)=>{
    resolveDone=resolve;rejectDone=reject;
  });
  // A supervisor that exits before READY cannot ever establish a trustworthy
  // process-tree owner. Reject the handshake immediately instead of waiting
  // for the full timeout and obscuring the actual startup failure.
  owner.failBeforeReady=error=>{
    if(!owner.ready && !owner.childExited)rejectReady(error);
  };
  owner.observeChildExit=(code,signal)=>{
    if(owner.childExited)return owner.statusPromise;
    owner.childExited=true;
    clearTimeout(owner.socketCloseTimer);
    owner.socketCloseTimer=null;
    owner.statusPromise=(async()=>{
      try {
        // The status file is not self-authenticating. A command running inside
        // the Job Object can pre-create it and then terminate this supervisor.
        // Only a normal supervisor exit may authenticate the cleanup receipt.
        if(code!==0 || signal!==null)
          throw makeProcessTreeCleanupError(
            'Windows Bash supervisor exited abnormally (exit '+String(code)+
            ', signal '+String(signal)+') and cannot authenticate a cleanup receipt.');
        const status=JSON.parse(await readFile(owner.statusPath,'utf8'));
        if(status?.ok!==true || status?.cleanupConfirmed!==true ||
           !Number.isSafeInteger(status.exitCode))
          throw makeProcessTreeCleanupError(
            'Windows Bash supervisor exited without a successful Job Object cleanup receipt: '+
            String(status?.error||'invalid status payload'));
        owner.done=true;
        owner.shellExitCode=status.exitCode;
        owner.ready=true;
        resolveReady();
        resolveDone();
      } catch(error) {
        const failure=error?.name==='ProcessTreeCleanupError'?error:
          makeProcessTreeCleanupError(
            'Windows Bash supervisor exited without a verifiable cleanup receipt (exit '+
            String(code)+', signal '+String(signal)+').',error);
        owner.failure=failure;
        if(!owner.ready)rejectReady(failure);
        rejectDone(failure);
        rejectPending(failure);
      }
    })();
    void owner.statusPromise.catch(()=>{});
    return owner.statusPromise;
  };
  void owner.readyPromise.catch(()=>{});
  void owner.donePromise.catch(()=>{});
  const rejectPending=error=>{
    const pending=owner.pendingKill;
    if(!pending)return;
    owner.pendingKill=null;
    clearTimeout(pending.timer);
    pending.reject(error);
  };
  const resolvePending=()=>{
    const pending=owner.pendingKill;
    if(!pending)return;
    owner.pendingKill=null;
    clearTimeout(pending.timer);
    pending.resolve();
  };
  const message=line=>{
    try { appendFileSync(owner.nodeStagePath, line+'\n'); } catch {}
    if(line==='READY') {
      owner.ready=true;
      resolveReady();
      return;
    }
    if(line==='KILLED') {
      owner.killed=true;
      resolvePending();
      return;
    }
    if(line.startsWith('ERROR ')) {
      let detail=line.slice(6);
      try{detail=Buffer.from(detail,'base64').toString('utf8');}catch{}
      owner.failure=makeProcessTreeCleanupError(
        'Windows Bash Job Object could not confirm descendant cleanup: '+detail);
      rejectDone(owner.failure);
      // The native owner itself is the last-resort KILL_ON_JOB_CLOSE handle.
      // If its control thread cannot reap the tree, terminate the owner so
      // Windows closes that handle and fails closed instead of hanging Bash.
      try{owner.child?.kill('SIGKILL');}catch{}
      rejectPending(owner.failure);
    }
  };
  server.on('connection',socket=>{
    if(owner.socket) {
      socket.destroy();
      return;
    }
    owner.socket=socket;
    socket.setEncoding('utf8');
    socket.on('data',chunk=>{
      owner.buffer+=chunk;
      while(true) {
        const index=owner.buffer.indexOf('\n');
        if(index<0)break;
        const line=owner.buffer.slice(0,index).replace(/\r$/,'');
        owner.buffer=owner.buffer.slice(index+1);
        message(line);
      }
    });
    socket.on('error',error=>{
      if(!owner.ready)rejectReady(error);
      if(!owner.done)rejectDone(makeProcessTreeCleanupError(
        'Windows Bash Job Object control channel failed.',error));
      if(!owner.done && !owner.killed) {
        try{owner.child?.kill('SIGKILL');}catch{}
      }
      rejectPending(makeProcessTreeCleanupError(
        'Windows Bash Job Object control channel failed.',error));
    });
    socket.on('close',()=>{
      owner.closed=true;
      // The native process may close its pipe handle just before Node emits
      // the child 'exit' event. Give that durable-status event a short grace
      // window; a pipe failure without process exit still fails closed.
      if(owner.childExited)return;
      clearTimeout(owner.socketCloseTimer);
      owner.socketCloseTimer=setTimeout(()=>{
        owner.socketCloseTimer=null;
        if(owner.childExited)return;
        const failure=makeProcessTreeCleanupError(
          'Windows Bash Job Object closed before a completed cleanup receipt.');
        if(!owner.ready)rejectReady(failure);
        if(!owner.done)rejectDone(failure);
        if(!owner.done && !owner.killed) {
          try{owner.child?.kill('SIGKILL');}catch{}
          if(owner.pendingKill)rejectPending(failure);
        }
      },1000);
      owner.socketCloseTimer.unref?.();
    });
  });
  await new Promise((resolveListen,rejectListen)=>{
    server.once('error',rejectListen);
    server.listen(pipePath,resolveListen);
  });
  owner.executable=join(process.env.SystemRoot||'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  owner.scriptPath=join(dirname(fileURLToPath(import.meta.url)),
    'windows-job-supervisor.ps1');
  owner.env={
    ...process.env,
    [commandEnvironmentName]:command,
    [cwdEnvironmentName]:cwd,
    [statusEnvironmentName]:statusPath,
    [shellEnvironmentName]:shellPath,
  };
  owner.args=[
    '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
    '-File',owner.scriptPath,
    commandEnvironmentName,cwdEnvironmentName,statusEnvironmentName,shellEnvironmentName,pipeName,
  ];
  owner.requestKill=child=>{
    owner.child=child;
    if(owner.killPromise)return owner.killPromise;
    owner.killPromise=(async()=>{
      const waitForDoneReceipt=async()=>{
        if(!owner.done) {
          let doneTimer;
          try {
            await Promise.race([
              owner.donePromise,
              new Promise((_,reject)=>{doneTimer=setTimeout(()=>reject(
                new Error('Windows Bash supervisor did not persist its cleanup receipt.')),1500);}),
            ]);
          } finally {
            clearTimeout(doneTimer);
          }
        }
        await waitForChildExit(child,5000);
        if(!owner.done || child.exitCode!==0)
          throw makeProcessTreeCleanupError(
            'Windows Bash supervisor exited without a successful Job Object cleanup receipt.');
      };
      if(owner.done||owner.killed||child.exitCode!==null||child.signalCode!==null) {
        await waitForDoneReceipt();
        return;
      }
      if(!owner.ready) {
        // A cold Windows host may spend several seconds compiling the native
        // Job Object supervisor with PowerShell Add-Type. Fail closed if it
        // still cannot establish ownership, but do not kill a healthy first
        // launch merely because compilation exceeded the old 5-second budget.
        let readyTimer;
        try {
          await Promise.race([
            owner.readyPromise,
            new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(
              new Error('Windows Bash Job Object handshake exceeded 20s.')),20000);}),
          ]);
        } catch(error) {
          try{child.kill('SIGKILL');}catch{}
          await waitForChildExit(child,5000).catch(()=>{});
          let detail=error instanceof Error?error.message:String(error);
          try {
            const status=JSON.parse(await readFile(owner.statusPath,'utf8'));
            if(status?.error)detail+='; supervisor error: '+status.error;
          } catch {}
          try {
            const stage=(await readFile(owner.stagePath,'utf8')).trim();
            if(stage)detail+='; supervisor stage: '+stage;
          } catch {}
          throw makeProcessTreeCleanupError(
            'Windows Bash Job Object ownership could not be established before cancellation: '+detail,error);
        } finally {
          clearTimeout(readyTimer);
        }
      }
      if(owner.done||owner.killed) {
        await waitForDoneReceipt();
        return;
      }
      if(!owner.socket || owner.socket.destroyed) {
        try{child.kill('SIGKILL');}catch{}
        await waitForChildExit(child,5000).catch(()=>{});
        throw makeProcessTreeCleanupError(
          'Windows Bash Job Object control channel is unavailable.');
      }
      await new Promise((resolveKill,rejectKill)=>{
        const pending={resolve:resolveKill,reject:rejectKill,timer:null};
        owner.pendingKill=pending;
        pending.timer=setTimeout(async()=>{
          if(owner.pendingKill!==pending)return;
          owner.pendingKill=null;
          try{child.kill('SIGKILL');}catch{}
          await waitForChildExit(child,5000).catch(()=>{});
          rejectKill(makeProcessTreeCleanupError(
            'Windows Bash Job Object did not confirm termination within 5s.'));
        },5000);
        owner.socket.write('KILL\n',error=>{
          if(error && owner.pendingKill===pending) {
            owner.pendingKill=null;
            clearTimeout(pending.timer);
            try{child.kill('SIGKILL');}catch{}
            rejectKill(makeProcessTreeCleanupError(
              'Could not signal the owning Windows Bash Job Object.',error));
          }
        });
      });
      // KILLED acknowledges that the Job Object is empty; wait for the
      // supervisor process itself to persist its final status receipt too.
      await waitForDoneReceipt();
    })();
    return owner.killPromise;
  };
  owner.close=async()=>{
    if(owner.socket && !owner.socket.destroyed)owner.socket.destroy();
    if(server.listening) {
      await new Promise(resolveClose=>server.close(()=>resolveClose())).catch(()=>{});
    }
    await unlink(statusPath).catch(()=>{});
    await unlink(stagePath).catch(()=>{});
    await unlink(nodeStagePath).catch(()=>{});
  };
  return owner;
}

function signalProcessTree(child, signalName) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    const owner=child.__agentCilWindowsJobSupervisor;
    if(owner)return owner.requestKill(child);
    // Compatibility fallback for any legacy/non-supervised ChildProcess:
    // never address a reaped numeric PID, because it may have been reused.
    if(child.exitCode!==null || child.signalCode!==null) {
      return Promise.reject(makeProcessTreeCleanupError(
        'Windows Bash process-tree cleanup could not be confirmed: the shell process already exited and its PID is no longer an authenticated descendant-tree owner.'));
    }
    return new Promise((resolveKill,rejectKill) => {
      let killer;
      let settled=false;
      let watchdog;
      const finish=(ok,reason)=>{
        if(settled)return;
        settled=true;
        clearTimeout(watchdog);
        if(ok){resolveKill();return;}
        try{child.kill('SIGKILL');}catch{}
        child.stdout?.destroy();
        child.stderr?.destroy();
        rejectKill(makeProcessTreeCleanupError(
          'Windows Bash process-tree cleanup could not be confirmed'+
          (reason?': '+reason:'')+'. Unowned descendants may remain.'));
      };
      try {
        const systemRoot=process.env.SystemRoot || 'C:\\Windows';
        killer=spawn(join(systemRoot,'System32','taskkill.exe'),
          ['/PID',String(child.pid),'/T','/F'],
          {windowsHide:true,stdio:'ignore',shell:false});
        killer.once('error',error=>finish(false,error.code||error.message));
        killer.once('close',(code,signal)=>
          finish(code===0,signal?'taskkill signal '+signal:'taskkill exit '+String(code)));
        watchdog=setTimeout(()=>{
          try{killer.kill('SIGKILL');}catch{}
          finish(false,'taskkill exceeded 5s');
        },5000);
      } catch(error) {
        finish(false,error instanceof Error?error.message:String(error));
      }
    });
  }
  if(!child.pid)return Promise.resolve();
  return killPosixProcessTree(child.pid, signalName, {
    captureDescendants: child.exitCode === null && child.signalCode === null,
  }).then(() => {});
}

// Port of the 2.1.304 ShellCommand state shape (liveShellCommands and
// pendingKillBackstops), retained as a headless adapter. The mature 2.1.88
// LocalShellTask/killShellTasks.ts exits also kill outstanding owned tasks.
// This is NOT a Windows Job Object nor a native persistent task registry.
const shellLifecycle = {
  liveShellCommands: new Set(),
  pendingKillBackstops: new Set(),
};

export function getShellLifecycleStatus() {
  return {
    liveShellCommands: shellLifecycle.liveShellCommands.size,
    pendingKillBackstops: shellLifecycle.pendingKillBackstops.size,
  };
}

export async function cleanupLiveShellCommands() {
  // Like 2.1.304's live-shell shutdown + await of pendingKillBackstops:
  // release every currently owned Bash, not just the last active tool.
  const owned = [...shellLifecycle.liveShellCommands];
  const outcomes=await Promise.allSettled(owned.map(shell => shell.kill()));
  // A kill task may have already been started by a signal/timeout.
  // Await the snapshot repeatedly in case the tracked set changed while
  // shell 'close' callbacks were still completing.
  const failures=outcomes.filter(item=>item.status==='rejected').map(item=>item.reason);
  while (shellLifecycle.pendingKillBackstops.size) {
    const ended=await Promise.allSettled([...shellLifecycle.pendingKillBackstops]);
    failures.push(...ended.filter(item=>item.status==='rejected').map(item=>item.reason));
  }
  // 2.1.88 ShellCommand/TaskOutput settles an execution only AFTER its
  // native stdout file is flushed, read and either retained or discarded.
  // The 2.1.304 process-tree kill backstop alone is NOT this finalization
  // barrier. Never release the owning SessionJournal while a killed Bash's
  // asynchronous ChildProcess 'close' handler can still mutate task output.
  const finalized=await Promise.allSettled(owned.map(shell=>shell.awaitFinalization()));
  failures.push(...finalized.filter(item=>item.status==='rejected').map(item=>item.reason));
  if(failures.length) {
    // Failed taskkill /T is not a successfully cleaned-up shell. Surface
    // uncertainty to CLI exit and preserve the prior session journal.
    throw new AggregateError(failures,
      'One or more Bash process trees could not be confirmed terminated.');
  }
}

async function runShellCommand(command, { cwd, signal, timeoutMs, maxOutputBytes, taskSession, runInBackground=false, taskManager, markSideEffectsStarted }) {
  if (signal?.aborted) throw abortError(signal);
  // Original 2.1.88 utils/Shell.ts exec() creates TaskOutput in file
  // mode BEFORE launching Bash. Both stdio fds point to the SAME file
  // handle so even multi-GB output never enters the Node heap.
  const taskOutput = new TaskOutput(undefined,null,true,maxOutputBytes,taskSession);
  const outputHandle = await taskOutput.initFileOutput();
  if(signal?.aborted) {
    await outputHandle.close();
    await taskOutput.deleteOutputFile();
    throw abortError(signal);
  }

  let windowsSupervisor;
  if(process.platform==='win32') {
    try {
      windowsSupervisor=await createWindowsJobSupervisor(command,cwd);
    } catch(error) {
      await outputHandle.close().catch(()=>{});
      await taskOutput.deleteOutputFile().catch(()=>{});
      throw error;
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settleCompletion, failCompletion;
    const completion=runInBackground?new Promise((resolve,reject)=>{
      settleCompletion=resolve;failCompletion=reject;
    }):null;
    // The foreground result / background completion is not observable until
    // the async close path has flushed TaskOutput, closed the native owner and
    // removed this shell from liveShellCommands. Resolving inside the close
    // handler's try block lets callers resume before its finally boundary.
    let completionOutcome=null;
    const finishResult=result=>{
      completionOutcome={kind:'result',value:result};
    };
    const finishError=error=>{
      completionOutcome={kind:'error',value:error};
    };
    let child;
    try {
      // A command may mutate the workspace as soon as the shell launches.
      // The CLI has already fsynced tool_started, so a subsequent spawn/
      // process failure must not become a retryable model tool_error.
      markSideEffectsStarted?.();
      if(windowsSupervisor) {
        child=spawn(windowsSupervisor.executable,windowsSupervisor.args,{
          cwd,
          env:windowsSupervisor.env,
          shell:false,
          windowsHide:true,
          stdio:['ignore',outputHandle.fd,outputHandle.fd],
        });
        child.__agentCilWindowsJobSupervisor=windowsSupervisor;
        windowsSupervisor.child=child;
        const observeSupervisorExit=(code,signal)=>{
          // Once the owning supervisor has exited, its durable receipt is
          // the remaining completion boundary; do not let the command timer
          // race status validation and misclassify a finished command.
          clearTimeout(timeout);
          clearTimeout(startupTimeout);
          void windowsSupervisor.observeChildExit(code,signal);
        };
        child.once('exit',observeSupervisorExit);
        if(child.exitCode!==null || child.signalCode!==null)
          observeSupervisorExit(child.exitCode,child.signalCode);
      } else {
        child = spawn(command, {
          cwd,
          shell: true,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', outputHandle.fd, outputHandle.fd],
        });
      }
    } catch(error) {
      // TaskOutput file-mode allocates a real FD BEFORE spawning Bash.
      // A synchronous spawn failure must not release the tool boundary
      // before closing/discarding that descriptor (2.1.88 Shell.ts exec).
      void (async()=>{
        try {
          await outputHandle.close();
          await windowsSupervisor?.close().catch(()=>{});
          await taskOutput.deleteOutputFile();
          rejectPromise(error);
        } catch(cleanupError) {
          const failure=new Error('Bash TaskOutput spawn cleanup failed: '+
            (cleanupError instanceof Error?cleanupError.message:String(cleanupError)),
            {cause:cleanupError});
          failure.name='TaskOutputPersistenceError';
          rejectPromise(failure);
        }
      })();
      return;
    }
    let timedOut = false;
    let spawnError;
    let terminationTask;
    let terminationConfirmed=false;
    let exitDrainTimer;
    let unsupportedBackground = false;
    let shutdownRequested = false;
    let backgroundAdmissionFailed = false;
    // Node EventEmitter does not await an async 'close' handler. Hold a
    // separate owner-finalization witness until TaskOutput finalization has
    // delivered a result (or a fatal error) to its original caller.
    let resolveFinalization;
    const finalization=new Promise(resolve=>{resolveFinalization=resolve;});

    const terminate = () => {
      if(terminationTask)return terminationTask;
      // Pinned 2.1.88 utils/ShellCommand.ts #doKill() uses
      // treeKill(pid,'SIGKILL') immediately on abort/timeout. The headless
      // shell owns an isolated POSIX process group; Windows uses taskkill /T
      // /F. Await the entire tree termination before settling Bash output.
      terminationTask=signalProcessTree(child,'SIGKILL');
      shellLifecycle.pendingKillBackstops.add(terminationTask);
      // Task completion must remove the same promise instance and may not
      // escape as an unhandled rejection during a normal tool shutdown.
      void terminationTask.finally(() => {
        shellLifecycle.pendingKillBackstops.delete(terminationTask);
      }).catch(() => {});
      return terminationTask;
    };
    const ownedShell = {
      kill() {
        shutdownRequested = true;
        return terminate();
      },
      awaitFinalization() {return finalization;},
    };
    shellLifecycle.liveShellCommands.add(ownedShell);

    let timeout;
    let startupTimeout;
    const startCommandTimeout=()=>{
      if(timeout)return;
      timeout=setTimeout(() => {
        timedOut = true;
        if(windowsSupervisor)windowsSupervisor.timeoutState={
          childExitCode:child?.exitCode??null,
          childSignalCode:child?.signalCode??null,
          ownerDone:windowsSupervisor.done,
          ownerKilled:windowsSupervisor.killed,
          socketDestroyed:windowsSupervisor.socket?.destroyed??null,
        };
        void terminate().catch(() => {});
      }, timeoutMs);
      timeout.unref?.();
    };
    if(windowsSupervisor) {
      // The user's timeout measures command execution, not the cold PowerShell
      // Add-Type/Job Object ownership handshake. Start it only after READY,
      // which is emitted after the suspended command has been assigned to the
      // Job Object and resumed. Keep a separate bounded startup deadline so a
      // broken supervisor cannot hang the CLI forever before READY.
      startupTimeout=setTimeout(()=>{
        if(windowsSupervisor.ready)return;
        spawnError ??= makeProcessTreeCleanupError(
          'Windows Bash supervisor failed to establish process-tree ownership within 20s.');
        try{child.kill('SIGKILL');}catch{}
      },20000);
      startupTimeout.unref?.();
      void windowsSupervisor.readyPromise.then(()=>{
        clearTimeout(startupTimeout);
        startupTimeout=null;
        startCommandTimeout();
      },error=>{
        clearTimeout(startupTimeout);
        startupTimeout=null;
        spawnError ??= makeProcessTreeCleanupError(
          'Windows Bash supervisor exited before establishing process-tree ownership.',error);
        try{child.kill('SIGKILL');}catch{}
      });
    } else {
      startCommandTimeout();
    }

    // EventTarget does not await Promise-returning event listeners. Never
    // allow a failed Windows taskkill to become an uncaught exception; the
    // close handler awaits and propagates the same owned terminationTask.
    const onAbort = () => { void terminate().catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });

    // File-FD mode: source Shell.ts closes the parent's duplicate AFTER
    // spawn attaches the error/exit listeners. The child retains its dup.
    // Unlike pipe mode, stdout/stderr are null and cannot hold JS memory.
    void outputHandle.close().catch(error=>{
      const failure=new Error('Bash TaskOutput descriptor close failed: '+error.message,{cause:error});
      failure.name='TaskOutputPersistenceError';
      spawnError ??= failure;
      void terminate().catch(()=>{});
    });
    child.once('error', error => {
      spawnError = error;
    });
    // The mature 2.1.88 ShellCommandImpl and 2.1.304 ShellCommand both
    // use 'exit' for the foreground result. 'close' can wait indefinitely
    // for grandchildren inheriting the shell's stdout/stderr pipes.
    // This headless CLI has no original LocalShellTask background registry
    // yet: give foreground pipe data a short drain window, then terminate
    // any unowned descendant tree instead of hanging the tool round or
    // silently leaving a background process with write access.
    child.once('exit', () => {
      if (terminationTask) return;
      if(process.platform !== 'win32' && child.pid) {
        // 2.1.304 ShellCommand reports leftRunningPgid if the foreground
        // shell exited but its process group still exists. This CLI has no
        // LocalShellTask background owner yet: fail closed and reap that
        // group, including descendants that discarded both stdio pipes.
        // A reaped shell with no descendants has no remaining process group.
        try {
          process.kill(-child.pid,0);
          unsupportedBackground = true;
        } catch(error) {
          // EPERM means the group exists but cannot be inspected. Treat it
          // as unsafe rather than reporting a successful command.
          if(error?.code !== 'ESRCH') unsupportedBackground = true;
        }
        if(unsupportedBackground) {
          exitDrainTimer = setTimeout(() => {
            if(!terminationTask)void terminate().catch(() => {});
            void terminationTask?.then(() => {
              child.stdout?.destroy();
              child.stderr?.destroy();
            }, () => {
              child.stdout?.destroy();
              child.stderr?.destroy();
            });
          },100);
          exitDrainTimer.unref?.();
          return;
        }
      }
      exitDrainTimer = setTimeout(() => {
        if (terminationTask) return;
        unsupportedBackground = true;
        void terminate().catch(() => {});
        // Node 'close' waits for all inherited pipe handles. After the
        // process-group kill has been dispatched, release inherited fds
        // regardless of whether a descendant ignores the group signal.
        void terminationTask.then(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        });
      }, 250);
      exitDrainTimer.unref?.();
    });
    child.once('close', async code => {
      try {
      clearTimeout(timeout);
      clearTimeout(startupTimeout);
      clearTimeout(exitDrainTimer);
      // A POSIX group with ignored/closed stdout can emit 'close' before
      // the delayed cleanup timer. Reap its surviving descendants anyway.
      if(unsupportedBackground && !terminationTask)void terminate().catch(() => {});
      signal?.removeEventListener('abort', onAbort);
      // Do not report cancellation as cleaned up while Windows taskkill
      // is still terminating grandchildren of cmd.exe.
      try {
        if(terminationTask) {
          await terminationTask;
          terminationConfirmed=true;
        }
      } catch(error) {
        spawnError ??= error;
      }

      let commandExitCode=code;
      let windowsSupervisorStage=null;
      if(windowsSupervisor) {
        // observeChildExit reads and validates the durable receipt to settle
        // owner.donePromise. Let that read finish before this close path
        // removes the same file, otherwise the two reads can race unlink().
        if(windowsSupervisor.statusPromise) {
          await windowsSupervisor.statusPromise.catch(()=>{});
        }
        let status=null;
        let statusError=null;
        try {
          windowsSupervisorStage=(await readFile(windowsSupervisor.stagePath,'utf8')).trim();
        } catch {}
        try {
          const nodeStages=(await readFile(windowsSupervisor.nodeStagePath,'utf8')).trim();
          if(nodeStages)windowsSupervisorStage+='\n[node] '+nodeStages;
        } catch {}
        try {
          status=JSON.parse(await readFile(windowsSupervisor.statusPath,'utf8'));
        } catch(error) {
          statusError=error;
        }
        if(windowsSupervisor.failure) {
          // Never let a pre-created status file override an abnormal owner
          // exit or a previously observed control-channel failure.
          spawnError ??= windowsSupervisor.failure;
        } else if(status) {
          if(status.ok!==true || status.cleanupConfirmed!==true ||
             !Number.isSafeInteger(status.exitCode)) {
            spawnError ??= makeProcessTreeCleanupError(
              'Windows Bash supervisor did not provide a successful Job Object cleanup receipt: '+
              String(status.error||'invalid status payload'));
          } else {
            commandExitCode=status.exitCode;
          }
        } else if(terminationConfirmed &&
          (timedOut || shutdownRequested || signal?.aborted || backgroundAdmissionFailed) &&
          (windowsSupervisor.done || windowsSupervisor.killed)) {
          // Cancellation was acknowledged only after the native Job Object
          // reported zero active members. A status-file failure cannot turn
          // an abort/timeout/shutdown into a successful command result.
          commandExitCode=windowsSupervisor.shellExitCode ?? code;
        } else if(!(spawnError && !child.pid)) {
          spawnError ??= makeProcessTreeCleanupError(
            'Windows Bash supervisor exited without a verifiable Job Object cleanup receipt.',
            statusError);
        }
        try {
          await unlink(windowsSupervisor.statusPath);
        } catch(error) {
          if(error?.code!=='ENOENT') {
            const failure=new Error('Windows Bash supervisor status cleanup failed: '+
              (error instanceof Error?error.message:String(error)),{cause:error});
            failure.name='TaskOutputPersistenceError';
            spawnError ??= failure;
          }
        }
        // The stage file is diagnostic only; its cleanup must never replace
        // the authoritative process-tree or TaskOutput result.
        await unlink(windowsSupervisor.stagePath).catch(()=>{});
      }

      if (spawnError?.name==='ProcessTreeCleanupError' ||
          spawnError?.name==='TaskOutputPersistenceError') {
        // The process-tree owner could not confirm that side effects
        // stopped. Throw into AgentLoop's fatal checkpoint fence rather
        // than mapping an ordinary tool_error and continuing the model.
        finishError(spawnError);
        return;
      }
      // In original file mode the kernel has already written output. Read
      // only the original bounded 30k prefix and retain the whole file
      // when it exceeds inline capacity. A lost/unreadable file is fatal.
      let capturedStdout;
      try {
        await taskOutput.flush();
        capturedStdout=await taskOutput.getStdout();
      } catch(error) {
        const failure=new Error('Bash TaskOutput persistence failed: '+error.message,{cause:error});
        failure.name='TaskOutputPersistenceError';
        finishError(failure);
        return;
      }
      if (signal?.aborted) {
        finishError(abortError(signal));
        return;
      }
      const result = {
        exit_code: Number.isInteger(commandExitCode) && commandExitCode >= 0 ? commandExitCode : 1,
        stdout: capturedStdout,
        stderr: taskOutput.getStderr(),
      };
      if(shutdownRequested) {
        result.exit_code = 1;
        result.error = 'Command terminated while releasing its owning CLI session.';
      }
      else if (timedOut) result.error = 'Command was killed or timed out.'+
        (windowsSupervisorStage?' (Windows supervisor stage: '+windowsSupervisorStage+')':'')+
        (windowsSupervisor?.timeoutState?' (Windows timeout state: '+JSON.stringify(windowsSupervisor.timeoutState)+')':'');
      else if (spawnError) result.error = spawnError.message;
      else if (unsupportedBackground) {
        // Do not report a successful foreground tool round for a detached
        // descendant we cannot yet register/clean up as LocalShellTask.
        result.exit_code = 1;
        result.error = 'Command left inherited-pipe background processes after the shell exited; unsupported background task was terminated.';
      } else if (commandExitCode !== 0) result.error = 'Command exited with status ' + String(commandExitCode) + '.';
      if(backgroundAdmissionFailed) {
        // A Bash tool whose background admission failed never returned a
        // trusted output path. Do not register an orphaned file as readable
        // task output; after confirmed cleanup discard that native file.
        await taskOutput.deleteOutputFile();
      } else if(taskOutput.isOverflowed) {
        // Original ExecResult.outputFilePath/Size/TaskId contract. Full
        // output is retained on disk, not truncated or silently discarded.
        result.outputFilePath=taskOutput.path;
        result.outputFileSize=taskOutput.outputFileSize;
        result.outputTaskId=taskOutput.taskId;
        // Register only after the native shell is finished, its output
        // identity has been checked and a real mapped tool result exists.
        // Read authorization never trusts a string returned by the model.
        taskOutput.registerCompletedOutput(cwd,{background:runInBackground});
      } else if(runInBackground) {
        // The original TaskOutput retains a background task file even
        // when its entire output fits the foreground inline preview.
        taskOutput.registerCompletedOutput(cwd,{background:true});
      } else if(!runInBackground) {
        // Source LocalShellTask MUST retain background output even when
        // small: TaskOutput/Read may be called after completion. Only
        // unregistered foreground results can delete redundant files.
        await taskOutput.deleteOutputFile();
      }
      finishResult(result);
      } catch(error) {
        // EventEmitter does not observe a Promise returned by an async
        // 'close' listener. If final output retention, registration or
        // cleanup fails, never leave Bash's completion Promise unresolved
        // or emit an unhandled rejection. The original TaskOutput finish
        // is an owning lifecycle boundary, not fire-and-forget work.
        const failure=(error?.name==='ProcessTreeCleanupError' ||
            error?.name==='TaskOutputPersistenceError')?error:
          new Error('Bash TaskOutput finalization failed: '+
            (error instanceof Error?error.message:String(error)),{cause:error});
        failure.name='TaskOutputPersistenceError';
        finishError(failure);
      } finally {
        // This is the ONLY ownership-release boundary: both native tree
        // termination and the complete async close/output path are done.
        await windowsSupervisor?.close().catch(()=>{});
        shellLifecycle.liveShellCommands.delete(ownedShell);
        resolveFinalization();
        // Settle only after the ownership-release boundary. This preserves
        // the source lifecycle contract: once the tool result is observable,
        // shutdown/TaskStop cannot still see a live shell for this command.
        if(completionOutcome) {
          if(completionOutcome.kind==='result') {
            if(runInBackground)settleCompletion(completionOutcome.value);
            else resolvePromise(completionOutcome.value);
          } else {
            if(runInBackground)failCompletion(completionOutcome.value);
            else rejectPromise(completionOutcome.value);
          }
        }
      }
    });
    if(runInBackground) {
      let registeredTaskId;
      // Register session ownership immediately, then wait for the Windows
      // supervisor's READY receipt before telling the model
      // the background task has started. The wrapper process spawning is not
      // itself proof that Bash is running: cold Add-Type compilation can take
      // several seconds, during which an immediate Read would see an empty log.
      void (async()=>{
        try {
          if(!taskManager)throw new Error('Background Bash requires session task ownership.');
          if(signal?.aborted)throw abortError(signal);
          registeredTaskId=taskManager.spawnShellTask({
            taskOutput,command,completion,kill:()=>ownedShell.kill(),
          });
          taskOutput.registerRunningOutput(cwd);
          if(windowsSupervisor)await windowsSupervisor.readyPromise;
          resolvePromise({
            exit_code:0,stdout:'',stderr:'',
            backgroundTaskId:registeredTaskId,
            outputTaskId:registeredTaskId,outputFilePath:taskOutput.path,
            message:'Command running in background with ID: '+registeredTaskId+
              '. Output is being written to: '+taskOutput.path,
          });
        }catch(error){
          backgroundAdmissionFailed = true;
          // This failure happens AFTER spawn(). The 2.1.88 LocalShellTask
          // owner must finish killing the actual shell/process tree before
          // returning any tool result or allowing the next model round.
          // Otherwise a rejected background Bash may keep changing files.
          // Suppress a ghost completion notice if registration succeeded but
          // the live output-path registration failed immediately afterward.
          if(registeredTaskId)taskManager.markTaskNotified(registeredTaskId);
          void (async()=>{
            try {
              await terminate();
              // 'close' also flushes/retains or disposes the native TaskOutput
              // FD. Its failure must not be hidden behind the registration
              // error; ProcessTreeCleanupError and TaskOutputPersistenceError
              // are fatal execution fences in the active AgentLoop.
              await completion;
              rejectPromise(error);
            }catch(cleanupError){
              rejectPromise(cleanupError);
            }
          })();
        }
      })();
    }  });
}

export async function createBuiltinTools({ workspace = process.cwd(), permissionContext = createCliPermissionContext(), taskSession = null, taskManager = null } = {}) {
  const { ToolRegistry } = await import('../../runtime/src/tool-registry.js');
  const root = resolve(workspace);
  const tools = new ToolRegistry();
  const manager=taskManager??createLocalShellTaskManager({sessionId:taskSession?.sessionId});
  // Original 2.1.88 ToolUseContext.readFileState: one active CLI session,
  // shared across successful Read → Edit/Write and subsequent model rounds.
  // A fresh --resume process must read again; never trust stale disk state.
  const readFileState = new Map();
  // Source getFileReadIgnorePatterns() is used by the original ripgrep
  // file discovery. Native CLI walker does not invoke ripgrep, so check
  // each candidate with the existing exact original gitignore matcher,
  // including path aliases/symlink resolution and explicit ask rules.
  // A denied/ask file must not be opened or listed even when the search
  // root (getPath) is allowed. No extra file-read authorization is inferred.
  const canSearchReadPath=hasOriginalReadScopedRules(permissionContext)
    ? filePath=>checkOriginalReadScopedRules(filePath,root,permissionContext).behavior==='passthrough'
    : null;


  // Preserve the original workspace-safe Read implementation and its direct
  // execute() API, but route actual AgentLoop execution through the 2.1.88
  // Tool.call + result mapper contract. No duplicate read implementation.
  const executeRead = async ({ file_path, offset, limit }, { signal } = {}) => {
    if (signal?.aborted) throw abortError(signal);
    const options=offset===undefined && limit===undefined
      ? undefined : {offset,limit};
    if(isReadableInternalTaskOutputPath(root,file_path,taskSession?.sessionId??null)) {
      const fh=await openReadableInternalTaskOutput(root,file_path,taskSession?.sessionId??null);
      try {
        const text=options===undefined
          ? await readTextHandle(fh,file_path,signal)
          : await readTextLinesHandle(fh,file_path,options,signal);
        if(signal?.aborted)throw abortError(signal);
        return text;
      }finally {
        await fh.close();
      }
    }
    const target = resolveWorkspacePath(root, file_path);
    await assertPathWithinWorkspace(root, target);
    if (signal?.aborted) throw abortError(signal);
    const handle=await openWorkspaceFile(root,target,constants.O_RDONLY);
    try {
      const before=await handle.stat();
      const text=options===undefined
        ? await readTextHandle(handle,target,signal)
        : await readTextLinesHandle(handle,target,options,signal);
      const after=await handle.stat();
      if(signal?.aborted)throw abortError(signal);
      // Only a verified stable descriptor read may authorize a later edit.
      // The underlying file could be truncated/replaced while Read awaits.
      if(before.dev!==after.dev || before.ino!==after.ino ||
         before.size!==after.size || before.mtimeMs!==after.mtimeMs ||
         before.ctimeMs!==after.ctimeMs) {
        throw new Error('File changed during Read. Read it again before writing to it.');
      }
      rememberOriginalFileRead(readFileState,target,text,after,{
        offset,limit,
      });
      return text;
    }finally{await handle.close();}
  };

  tools.register({
    name: 'Read',
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    // Built-in workspace-only read/search operations may start at tool_use
    // block_stop, before the model has finished streaming.
    canRunDuringStream: true,
    description: 'Read a UTF-8 workspace file or a verified completed Bash output file. Use zero-based offset and limit for large files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    execute: executeRead,
    call: async (input, context) => ({ data: await executeRead(input, context) }),
    mapToolResultToToolResultBlockParam: (data, toolUseId) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: data,
    }),
  });

  tools.register({
    name: 'Write',
    maxResultSizeChars: 100_000,
    description: 'Create or replace a UTF-8 text file within the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    execute: async ({ file_path, content }, { markSideEffectsStarted } = {}) => {
      const target = resolveWorkspacePath(root, file_path);
      await assertPathWithinWorkspace(root, target);
      // Original 2.1.88 FileWriteTool requires a full prior Read of an
      // existing file. A rejected unread/stale Write must remain an ordinary
      // recoverable tool failure, NOT a fatal side-effect reconciliation.
      // Only signal irreversible mutations at their true onset.
      try {
        await stat(dirname(target));
      } catch (error) {
        if(error?.code!=='ENOENT')throw error;
        // Recursive mkdir may create some ancestors before a later failure.
        markSideEffectsStarted?.();
      }
      await mkdir(dirname(target), { recursive: true });
      let targetInfo;
      try { targetInfo=await lstat(target); }
      catch(error){ if(error?.code!=='ENOENT')throw error; }
      const existed=Boolean(targetInfo);
      // Opening an existing directory fails without performing a mutation.
      // For creation O_EXCL prevents a file appearing between lstat and
      // open from being silently overwritten without prior full Read.
      if(!existed)markSideEffectsStarted?.();
      const flags=constants.O_RDWR |
        (existed?0:(constants.O_CREAT|constants.O_EXCL));
      const handle=await openWorkspaceFile(root,target,flags,0o666);
      try {
        await assertOpenedFileWithinWorkspace(root,target,handle);
        if(existed){
          const current=await readTextHandle(handle,target);
          checkOriginalFileReadState(readFileState,target,current,await handle.stat());
          // No mutation occurs until this point for existing regular files.
          markSideEffectsStarted?.();
        }
        await writeTextHandle(handle,content);
        rememberOriginalFileRead(readFileState,target,content,await handle.stat());
      } finally { await handle.close(); }
      return { path: relative(root, target).split(sep).join('/'), bytes: Buffer.byteLength(content), written: true };
    },
  });

  tools.register({
    name: 'Edit',
    maxResultSizeChars: 100_000,
    description: 'Replace one unique text occurrence in a workspace file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', minLength: 1 },
        old_string: { type: 'string', minLength: 1 },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    execute: async ({ file_path, old_string, new_string }, { markSideEffectsStarted } = {}) => {
      const target = resolveWorkspacePath(root, file_path);
      const handle = await openWorkspaceFile(root, target, constants.O_RDWR);
      try {
        const original = await readTextHandle(handle, target);
        await assertOpenedFileWithinWorkspace(root, target, handle);
        // Preserve FileEditTool.checkPermissions and call ordering:
        // staleness/full-Read validation precedes searching old_string, so
        // external edits are reported as conflicts, not missing matches.
        const before=await handle.stat();
        checkOriginalFileReadState(readFileState,target,original,before);
        const first = original.indexOf(old_string);
        if (first < 0) throw new Error('old_string was not found in ' + file_path);
        if (original.indexOf(old_string, first + old_string.length) >= 0) {
          throw new Error('old_string occurs more than once; provide a unique match.');
        }
        const updated = original.slice(0, first) + new_string + original.slice(first + old_string.length);
        // Keep the original post-permission recheck on the opened descriptor
        // immediately before the actual mutation. File contents were read
        // from this same verified handle above.
        await assertOpenedFileWithinWorkspace(root, target, handle);
        checkOriginalFileReadState(readFileState,target,original,await handle.stat());
        // Mark only AFTER full-read, uniqueness and inode safety checks.
        markSideEffectsStarted?.();
        await writeTextHandle(handle, updated);
        rememberOriginalFileRead(readFileState,target,updated,await handle.stat());
        return { path: relative(root, target).split(sep).join('/'), edited: true };
      } finally {
        await handle.close();
      }
    },
  });

  tools.register({
    name: 'Glob',
    maxResultSizeChars: 100_000,
    isConcurrencySafe: () => true,
    // Built-in workspace-only read/search operations may start at tool_use
    // block_stop, before the model has finished streaming.
    canRunDuringStream: true,
    description: 'Find workspace files matching a glob pattern such as src/**/*.js or *.json.',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string', minLength: 1 } },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async ({ pattern }, { signal } = {}) => {
      if (signal?.aborted) throw abortError(signal);
      if (pattern.startsWith('/') || pattern.split('/').includes('..')) {
        throw new Error('Glob pattern must stay within the workspace.');
      }
      const matcher = globToRegExp(pattern);
      const walked = await walkFiles(root, undefined, signal, canSearchReadPath);
      if (signal?.aborted) throw abortError(signal);
      const matches = walked.files
        .map((file) => relative(root, file).split(sep).join('/'))
        .filter((file) => matcher.test(file))
        .slice(0, 500);
      return { matches, truncated: walked.truncated || matches.length >= 500 };
    },
  });

  tools.register({
    name: 'Grep',
    maxResultSizeChars: 20_000,
    isConcurrencySafe: () => true,
    // Built-in workspace-only read/search operations may start at tool_use
    // block_stop, before the model has finished streaming.
    canRunDuringStream: true,
    description: 'Search text files in the workspace using a regular expression.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async ({ pattern, path = '.', ignore_case = false }, { signal } = {}) => {
      if (signal?.aborted) throw abortError(signal);
      const start = resolveWorkspacePath(root, path);
      await assertPathWithinWorkspace(root, start);
      const info = await stat(start);
      // An exact input file may be denied even when the caller directly
      // invokes the tool without the AgentLoop permission preflight.
      // Preserve source per-file filtering before readTextFile() opens fd.
      const walked = info.isFile()
        ? {files:canSearchReadPath && !canSearchReadPath(start)?[]:[start],truncated:false}
        : await walkFiles(start, undefined, signal, canSearchReadPath);
      if (signal?.aborted) throw abortError(signal);
      const files = walked.files;
      const matcher = new RegExp(pattern, ignore_case ? 'i' : '');
      const matches = [];
      let truncated = walked.truncated;
      for (const file of files) {
        if (signal?.aborted) throw abortError(signal);
        if (matches.length >= 200) { truncated = true; break; }
        let content;
        try {
          content = await readTextFile(root, file, undefined, signal);
        } catch (error) {
          if (signal?.aborted) throw abortError(signal);
          if (error instanceof Error && (error.message.includes('1 MiB') || error.message.includes('binary file'))) continue;
          throw error;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (signal?.aborted) throw abortError(signal);
          if (matcher.test(lines[i])) {
            matches.push({
              path: relative(root, file).split(sep).join('/'),
              line: i + 1,
              text: lines[i].slice(0, 500),
            });
            if (matches.length >= 200) { truncated = true; break; }
          }
          matcher.lastIndex = 0;
        }
      }
      return { matches, truncated };
    },
  });

  tools.register({
    name: 'Bash',
    maxResultSizeChars: 30_000,
    persistenceThresholdCeiling: 128_000,
    description: 'Run a shell command in the workspace. Requires approval unless permitted by an exact command rule.',
    // Original BashTool.checkPermissions delegates to bashToolHasPermission.
    // Until AST, wrapper, wildcard and sandbox matching are transplanted, this
    // is restricted to exact command rule decisions only (fail closed).
    checkPermissions: async input => bashToolCheckAstPermission(input, permissionContext, {workspace:root}),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 },
        run_in_background: {type:'boolean'},
      },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async ({ command, timeout_ms = 30000, run_in_background = false }, { signal, markSideEffectsStarted } = {}) => runShellCommand(command, {
      cwd: root,
      signal,
      timeoutMs: timeout_ms,
      maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
      taskSession,
      runInBackground:run_in_background,
      taskManager:manager,
      markSideEffectsStarted,
    }),
    // Source 2.1.88 BashTool.call() interprets raw ShellCommand status
    // after process cleanup; execute() retains its raw OS result contract.
    // The durable P0 side-effect marker MUST follow this Tool.call path,
    // not just execute(), so shell spawn cannot be retried after mutation.
    call: async (input, context) => {
      const result=await runShellCommand(input.command,{
        cwd:root,signal:context?.signal,timeoutMs:input.timeout_ms??30000,
        maxOutputBytes:MAX_TOOL_OUTPUT_BYTES,
        taskSession,runInBackground:input.run_in_background??false,
        taskManager:manager,
        markSideEffectsStarted:context?.markSideEffectsStarted,
      });
      if(!input.run_in_background){
        const meaning=interpretCommandResult(input.command,result.exit_code,
          result.stdout??'',result.stderr??'');
        const genericExit='Command exited with status '+result.exit_code+'.';
        const lifecycleError=result.error && result.error!==genericExit
          ?result.error:undefined;
        if(lifecycleError || meaning.isError){
          const reason=lifecycleError??meaning.message??
            'Command failed with exit code '+result.exit_code;
          // Source BashTool.call() has a COMPLETE shell result here. Throwing
          // after the process already launched would trip the P0 durable
          // unfinalized-side-effects fence and permanently stop a legitimate
          // model test→repair loop. Return the original completed failure
          // as an authenticated is_error tool_result instead; the owning
          // AgentLoop dispatches PostToolUseFailure AFTER its durable witness.
          // Actual unfinished shell/spawn/cleanup exceptions still throw and
          // remain fenced against side-effect replay.
          result.sourceCommandFailure = [reason,result.stdout,result.stderr]
            .filter(Boolean).join(String.fromCharCode(10));
        } else {
          delete result.error;
          if(meaning.message)result.message=meaning.message;
        }
      }
      return {data:result};
    },
    mapToolResultToToolResultBlockParam:(data,toolUseId)=>{
      // Port BashTool.mapToolResultToToolResultBlockParam: once Shell has
      // spilled output to its authenticated TaskOutput file, send a bounded
      // preview plus the exact outputTaskId/path/size witness. Serializing
      // the full 30K stdout prefix first would cross maxResultSizeChars and
      // generic tool-result persistence would hide those recovery fields.
      const hasSpilledOutput=typeof data.outputFilePath==='string' &&
        typeof data.outputTaskId==='string' &&
        Number.isSafeInteger(data.outputFileSize) && data.outputFileSize>0;
      let mappedData=data;
      if(hasSpilledOutput){
        const preview=generatePreview(
          typeof data.stdout==='string'?data.stdout:'',PREVIEW_SIZE_BYTES);
        const hasMore=preview.hasMore ||
          data.outputFileSize>Buffer.byteLength(preview.preview,'utf8');
        const persistedPreview=buildLargeToolResultMessage({
          filepath:data.outputFilePath,
          originalSize:data.outputFileSize,
          isJson:false,
          preview:preview.preview,
          hasMore,
        });
        mappedData={
          ...data,
          stdout:persistedPreview,
          ...(typeof data.sourceCommandFailure==='string'
            ?{
              sourceCommandFailure:data.sourceCommandFailure.slice(0,PREVIEW_SIZE_BYTES),
              sourceCommandFailureTruncated:
                data.sourceCommandFailure.length>PREVIEW_SIZE_BYTES,
            }:{}),
        };
      }
      // Original commandSemantics decides which completed nonzero exits
      // are failures. Preserve the completed failure and its output witness;
      // never turn a finished process into a partial-side-effect exception.
      return {
        type:'tool_result',tool_use_id:toolUseId,
        ...(data.sourceCommandFailure?{is_error:true}:{}),
        content:data.sourceCommandFailure && !hasSpilledOutput
          ?'Tool execution failed: ShellCommandError: '+data.sourceCommandFailure
          :JSON.stringify(mappedData),
      };
    },
  });

  tools.register({
    name:'TaskOutput',
    description:'Read output and status from a background Bash task. Prefer Read on the output file for completed tasks.',
    isConcurrencySafe:()=>true,
    inputSchema:{
      type:'object',
      properties:{
        task_id:{type:'string'},
        block:{type:'boolean'},
        timeout:{type:'integer',minimum:0,maximum:600000},
      },
      required:['task_id'],additionalProperties:false,
    },
    execute:async(input,{signal}={})=>manager.getTaskOutput(input,signal),
    maxResultSizeChars:100000,
  });
  tools.register({
    name:'TaskStop',
    maxResultSizeChars: 100_000,
    description:'Stop a session-owned running background Bash task by ID.',
    inputSchema:{
      type:'object',
      properties:{
        task_id:{type:'string'},
        shell_id:{type:'string'},
      },
      additionalProperties:false,
    },
    execute:async({task_id,shell_id},{markSideEffectsStarted}={})=>
      manager.stopTask(task_id??shell_id,{markSideEffectsStarted}),
  });

  return tools;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error('Prompt from stdin exceeds the 1 MiB limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function formatCliError(error, locale, seen = new Set()) {
  if (!(error instanceof Error)) return localizeCliMessage(String(error), locale);
  if (seen.has(error)) return localizeCliMessage(error.message, locale);
  seen.add(error);
  const message = localizeCliMessage(error.message, locale);
  const nested = error instanceof AggregateError
    ? [...error.errors]
    : error.cause instanceof Error ? [error.cause] : [];
  const details = nested.map(item => formatCliError(item, locale, seen)).filter(Boolean);
  return details.length ? [message, ...details].join('\n') : message;
}

function printError(error, locale = 'en') {
  process.stderr.write(t(locale, 'errorPrefix') + ' ' + formatCliError(error, locale) + '\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const languageState = await loadLanguagePreference({ env });
  let locale = languageState.locale;
  let languagePreference = languageState.preference;
  const printLocalizedError = error => printError(error, locale);
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    printLocalizedError(error);
    return 2;
  }

  if (options.mode === 'version') {
    process.stdout.write('agent-cil ' + VERSION + '\n');
    return 0;
  }
  if (options.language !== undefined) {
    locale = resolveLanguage(options.language, env);
    languagePreference = options.language;
    try {
      await saveLanguagePreference(languagePreference, { env });
    } catch (error) {
      process.stderr.write(t(locale, 'errorPrefix') + ' ' + t(locale, 'languageSaveFailed', {
        reason: error instanceof Error ? error.message : String(error),
      }) + '\n');
    }
  }

  if (options.mode === 'help') {
    process.stdout.write(getHelp(locale, VERSION));
    return 0;
  }

  const provider = options.provider;
  const credentialEnvName = provider === 'openai' ? 'OPENAI_API_KEY'
    : provider === 'deepseek' ? 'DEEPSEEK_API_KEY or ANTHROPIC_API_KEY' : 'ANTHROPIC_API_KEY';
  const apiKey = provider === 'openai' ? env.OPENAI_API_KEY
    : provider === 'deepseek' ? (env.DEEPSEEK_API_KEY || env.ANTHROPIC_API_KEY)
      : env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    printLocalizedError(credentialEnvName + ' is required. Supply it via the environment, not CLI arguments.');
    return 2;
  }

  // Pinned 2.1.88 utils/model/model.ts: CLI --model overrides
  // ANTHROPIC_MODEL, then source alias parsing honors ANTHROPIC_DEFAULT_*
  // overrides. 2.1.304 retains those aliases, though its dynamic remote
  // model catalog is not yet ported. Never reinterpret DeepSeek/OpenAI IDs.
  // Unsupported [1m] mode cannot be sent to the API as a literal model ID.
  let selectedModel;
  let requestedModel;
  try{
    requestedModel=options.model !== undefined
      ? options.model
      : provider==='openai' ? (env.OPENAI_MODEL||'gpt-5.1')
      : provider==='deepseek' ? (env.DEEPSEEK_MODEL||'deepseek-flash')
      : (env.ANTHROPIC_MODEL||'claude-sonnet-4-5');
    selectedModel=resolveOriginalCliModel({
      provider,model:requestedModel,permissionMode:options.permissionMode,env,
    });
  }catch(error){
    printLocalizedError('Model configuration failed: '+
      (error instanceof Error?error.message:String(error)));
    return 2;
  }

  // Source /model default clears the current session override. This
  // headless CLI has no subscription/settings model catalog yet; its
  // already-selected startup model is the safe, resolved fallback.
  const startupModel=selectedModel;
  let activeModelSetting=requestedModel;

  let prompt = options.prompt;
  // A positional first prompt should start the interactive session on a TTY,
  // not silently force one-shot mode. --print remains explicitly one-shot.
  const interactiveInput = process.stdin.isTTY && process.stdout.isTTY && !options.print;
  if (options.print && prompt.length === 0 && process.stdin.isTTY && !options.resume) {
    printLocalizedError('No prompt provided. Pass a prompt or pipe stdin.');
    return 2;
  }
  if (!interactiveInput && prompt.length === 0 &&
      (!options.resume || !process.stdin.isTTY)) {
    // An explicit --resume can continue a durable tool checkpoint without
    // another user message, but a piped prompt still takes precedence.
    // readStdin() reaches EOF for an empty pipe; it does not invent content.
    try {
      prompt = await readStdin();
    } catch (error) {
      printLocalizedError(error);
      return 2;
    }
  }
  if (!interactiveInput && prompt.length === 0 && !options.resume) {
    printLocalizedError('No prompt provided. Pass a prompt, pipe stdin, or start an interactive session.');
    return 2;
  }

  const workspace = resolve(options.cwd);
  try {
    const workspaceInfo = await stat(workspace);
    if (!workspaceInfo.isDirectory()) {
      throw new Error('Path is not a directory.');
    }
  } catch (error) {
    printLocalizedError('Workspace directory is unavailable: ' + workspace + ' (' +
      (error instanceof Error ? error.message : String(error)) + ')');
    return 2;
  }

  // Do not attach a readline listener until configuration and runtime setup succeed.
  // Otherwise a constructor/import error can leave a TTY handle open before the cleanup finally block.
  let rl;
  let tui;

  const { AgentLoop } = await import('../../runtime/src/agent-loop.js');
  // Only the transport changes: both providers feed the same 2.1.88-derived
  // query loop and the same permission-checked Read/Edit/Bash tools.
  let model;
  if (provider === 'openai') {
    const { OpenAIChatAdapter } = await import('../../runtime/src/openai-chat-adapter.js');
    model = new OpenAIChatAdapter({
      apiKey,
      model: selectedModel,
      baseUrl: options.baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      system: options.system,
    });
  } else {
    const { AnthropicMessagesAdapter } = await import('../../runtime/src/anthropic-messages-adapter.js');
    model = new AnthropicMessagesAdapter({
      apiKey,
      model: selectedModel,
      baseUrl: options.baseUrl || (provider === 'deepseek'
        ? (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic')
        : (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')),
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      system: options.system,
    });
  }
  const permissionContext = createCliPermissionContext({
    allowEdits: options.allowEdits,
    permissionMode: options.permissionMode,
    permissionRules: options.permissionRules,
  });
  let toolHooks = { PreToolUse: [], PostToolUse: [], PostToolUseFailure: [] };
  if (options.hooksFile) {
    try {
      const { loadToolHookSettings } = await import(
        '../../runtime/src/legacy-tools/pretooluse-node-compat.js'
      );
      // Explicit CLI flag is the trust boundary. Never auto-execute commands
      // from an untrusted repository's settings on startup.
      toolHooks = await loadToolHookSettings(options.hooksFile);
    } catch (error) {
      printLocalizedError('Tool Hook configuration failed: ' +
        (error instanceof Error ? error.message : String(error)));
      return 2;
    }
  }
  // Source 2.1.88 autoCompact.ts enables automatic summarization at
  // getEffectiveContextWindowSize(model)-AUTOCOMPACT_BUFFER_TOKENS.
  // Earlier CLI hard-disabled auto-compact for ALL Anthropic requests (0).
  // Reuse the source 200K window branch for pinned known first-party IDs,
  // with the original env gates; resolve each turn so /model cannot keep
  // a threshold from a different model. Custom/unknown model context size
  // remains explicitly opt-in. DeepSeek's existing 850K threshold is unchanged.
  let compactThreshold = options.compactThreshold;
  if (compactThreshold === undefined && env.AGENT_CIL_COMPACT_THRESHOLD !== undefined) {
    compactThreshold = Number(env.AGENT_CIL_COMPACT_THRESHOLD);
    if (!Number.isSafeInteger(compactThreshold) || compactThreshold < 0 ||
      compactThreshold > 2000000) {
      printLocalizedError('AGENT_CIL_COMPACT_THRESHOLD must be an integer from 0 to 2000000.');
      return 2;
    }
  }
  compactThreshold ??= provider==='deepseek' ? 850000 :
    provider==='anthropic'
      ? modelName=>getOriginalCliAutoCompactThreshold(modelName,{provider,env})
      : 0;
  const { createAutoCompact } = await import('../../runtime/src/legacy-compact/auto-compact.js');
  const autoCompact = createAutoCompact({ thresholdTokens: compactThreshold });
  const { openSessionJournal } = await import('../../runtime/src/legacy-session/session-storage.js');
  let journal;
  try {
    journal = await openSessionJournal({
      workspace,
      ...(options.sessionId || options.resume
        ? { sessionId: options.sessionId || options.resume } : {}),
      resume: !!options.resume,
    });
  } catch(error) {
    printLocalizedError('Session initialization failed: ' +
      (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  // CLI's versioned session metadata records the original /model session
  // override without inventing a user message. Resolve it again through
  // the already-ported 2.1.88 aliases before any Query or tool is created.
  // Source model override precedes startup --model, but a provider change
  // must never send a stale first-party model ID to a different API.
  if(options.resume && journal.modelOverride?.setting!==null &&
     journal.modelOverride?.setting!==undefined){
    const saved=journal.modelOverride;
    if(saved.provider!==provider){
      printLocalizedError('Session model override belongs to provider '+saved.provider+
        '; resume with that provider or clear the override in its original session.');
      await journal.close();
      return 2;
    }
    try{
      const restoredModel=resolveOriginalCliModel({
        provider,model:saved.setting,permissionMode:options.permissionMode,env,
      });
      model.setModel(restoredModel);
      activeModelSetting=saved.setting;
      process.stderr.write('[model] Restored session model: '+model.model+'\n');
    }catch(error){
      printLocalizedError('Session model recovery failed: '+
        (error instanceof Error?error.message:String(error)));
      await journal.close();
      return 2;
    }
  }
  process.stderr.write(t(locale, 'sessionStarted', {
    id: journal.id,
    state: options.resume ? t(locale, 'sessionResumed') : t(locale, 'sessionCreated'),
  }) + '\n');
  if(journal.needsToolReconciliation) {
    if(journal.startedToolExecutions.length) {
      process.stderr.write(t(locale, 'sessionStartedToolExecutions', {
        count: journal.startedToolExecutions.length,
      }) + '\n');
    }
    if(journal.mappedToolResults.length) {
      process.stderr.write(t(locale, 'sessionMappedResults', {
        count: journal.mappedToolResults.length,
      }) + '\n');
    }
    // Original Session retains an assistant tool_use even when the process
    // dies before its matching tool_result. Never replay that assistant
    // request through the model: Write/Bash may already have taken effect.
    printLocalizedError(journal.needsToolContextReview
      ? 'Session contains completed tool results but failed Hook/native context normalization. Inspect the preserved results and Hook side effects before continuing; automatic replay is unsafe.'
      : 'Session contains an unfinished tool batch. Inspect side effects and reconcile the session before continuing; automatic replay is unsafe.');
    await journal.close();
    return 2;
  }
  if (!interactiveInput && prompt.length === 0 && !journal.canContinueWithoutPrompt) {
    // Source insertMessageChain() saves initial user messages before the
    // provider responds. Resume either an unanswered prompt or a fully
    // committed tool batch, never a previously completed answer.
    printLocalizedError('Session has no committed pending user prompt or tool result. Supply a new prompt to continue.');
    await journal.close();
    return 2;
  }
  // Source Session task ownership: only committed Bash tool_result records
  // can restore output permissions in a fresh CLI process, and the path
  // itself is independently derived from canonical workspace + session UUID.
  // Never allow arbitrary transcript text to become a global /tmp grant.
  try {
    if(options.resume) {
      await restoreCompletedTaskOutputs({
        workspace,sessionId:journal.id,messages:journal.messages,
      });
    }
  }catch(error) {
    printLocalizedError('Task output recovery failed: '+
      (error instanceof Error?error.message:String(error)));
    await journal.close();
    return 2;
  }
  // Original 2.1.88 sessionStorage.insertMessageChain() records the
  // initial human input BEFORE entering Query. A fresh named CLI session
  // previously delayed this until after ToolRegistry/AgentLoop/readline/
  // signal initialization, so a setup exception left an empty, unusable
  // transcript that --resume cannot trust. Persist only a real supplied
  // first prompt under the existing fsynced journal/lock, before that setup.
  // A fully empty session still fails closed rather than treating an
  // externally truncated journal as a safe fresh conversation.
  const initialInputCommitted=!options.resume && prompt.length>0;
  if(initialInputCommitted) {
    try {
      await journal.append({
        messages:[{role:'user',content:prompt}],kind:'input',
      });
    }catch(error){
      printLocalizedError('Initial session input checkpoint failed: '+
        (error instanceof Error?error.message:String(error)));
      await journal.close();
      return 2;
    }
  }

  // The original 2.1.88 Query/LocalShellTask owner exists from the
  // moment the session lock is acquired, not only when the first prompt
  // is run. The 2.1.304 shutdown path also waits for task kill backstops.
  // Cover every fallible runtime setup operation with the SAME finally
  // that already owns shell cancellation and fsynced journal release.
  let taskManager;
  let onSigint, onSigterm;
  let interactiveQuestionController;
  let modelJournalFailure = false;
  try {
    taskManager=createLocalShellTaskManager({sessionId:journal.id});
  const tools = await createBuiltinTools({
    workspace,permissionContext,taskSession:{workspace,sessionId:journal.id},
    taskManager,
  });
  // Original 2.1.88 query.ts gates aggregate tool-result budgeting behind
  // GrowthBook tengu_hawthorn_steeple (default false). This local CLI has no
  // GrowthBook client, so expose an explicit opt-in without silently changing
  // the default behavior of existing sessions.
  const contentReplacementEnabled = isEnvTruthy(env.AGENT_CIL_TOOL_RESULT_BUDGET);
  const toolResultBudgetLimit = contentReplacementEnabled
    ? getPerMessageBudgetLimit() : 200_000;
  const loop = new AgentLoop({
    model,
    tools,
    toolResultStorage: {
      workspace,
      directory: join(workspace, '.agent-cil', 'sessions', journal.id, 'tool-results'),
    },
    contentReplacementEnabled,
    contentReplacementRecords: journal.contentReplacements,
    toolResultBudgetLimit,
    onContentReplacement: records => journal.appendContentReplacements(records),
    preToolUseHooks: toolHooks.PreToolUse,
    postToolUseHooks: toolHooks.PostToolUse,
    postToolUseFailureHooks: toolHooks.PostToolUseFailure,
    hookWorkspace: workspace,
    permissionMode: permissionContext.mode,
    // Source createBaseHookInput() identifies the actual session transcript.
    // Use the already-locked, fsynced SessionJournal, not a second file.
    hookSessionId: journal.id,
    hookTranscriptPath: journal.path,
    compactContext: context => autoCompact.compact(context),
    // The old sessionStorage.ts enqueues JSONL transcript commits. The
    // portable Node journal implements only completed checkpoint records.
    // Await it in Query before any subsequent provider request.
    onSessionCheckpoint: checkpoint => journal.append(checkpoint),
    // The source non-MCP mapped result exists before PostToolUse. Preserve
    // it in the same fsynced, locked journal while the command Hook runs.
    onMappedToolResult: result => journal.appendMappedToolResult(result),
    // Original StreamingToolExecutor executing transition, durably linked
    // only after final permission and before invoking a side-effecting tool.
    onToolExecutionStart: result => journal.appendToolExecutionStart(result),
    // Native 2.1.88 LocalShellTask.enqueueShellNotification is a pending
    // user-side message, durably committed in Query before provider delivery.
    // A TaskOutput/TaskStop result suppresses duplicate completion notices.
    getPendingTaskNotifications:()=>taskManager.pendingNotifications(),
    onTaskNotificationsCommitted:taskIds=>taskManager.acknowledgeNotifications(taskIds),
    permissionPolicy: createCliPermissionPolicy({
      workspace,
      permissionContext,
      sessionId:journal.id,
      taskManager,
    }),
    maxTurns: options.maxTurns,
    approvalHandler: async ({ name, input, reason, defaultToNo, signal }) => {
      if (tui && !options.print) {
        const approval = await tui.requestApproval({ name, input, reason, defaultToNo, signal });
        if (approval?.approved && Array.isArray(approval.permissionUpdates) &&
            approval.permissionUpdates.length > 0) {
          const command = name === 'Bash' && typeof input?.command === 'string'
            ? input.command.trim() : '';
          const [update] = approval.permissionUpdates;
          const rule = update?.rules?.[0];
          // Source permission updates must grant only the exact reviewed
          // Bash command, for this session; never broaden an Ink selection.
          const validExactSessionGrant = approval.permissionUpdates.length === 1 &&
            command.length > 0 &&
            update.type === 'addRules' &&
            update.behavior === 'allow' &&
            update.destination === 'session' &&
            Array.isArray(update.rules) &&
            update.rules.length === 1 &&
            rule?.toolName === 'Bash' &&
            rule.ruleContent === command;
          if (!validExactSessionGrant) {
            return { approved: false, reason: 'Invalid session permission update; the tool call was denied.' };
          }
          const updatedContext = applyPermissionUpdates(permissionContext, approval.permissionUpdates);
          // AgentLoop performs its mandatory post-approval reauthorization
          // against this same source permission context.
          Object.assign(permissionContext, updatedContext);
          const { permissionUpdates: _permissionUpdates, ...resolvedApproval } = approval;
          return resolvedApproval;
        }
        return approval;
      }
      if (!rl || options.print || !process.stdin.isTTY) {
        process.stderr.write(t(locale, 'permissionDeniedUnavailable', { tool: name }) + '\n');
        return { approved: false, reason: 'Interactive approval is unavailable.' };
      }
      process.stderr.write('\n' + t(locale, 'permissionRequest', { tool: name, reason }) + '\n');
      process.stderr.write(JSON.stringify(input, null, 2) + '\n');
      const answer = await rl.question(t(locale, 'approvalPrompt'), { signal });
      return { approved: /^(y|yes)$/i.test(answer.trim()), reason: 'User did not approve the tool call.' };
    },
  });

  // Original Ink renderer owns raw TTY input. Readline is a fallback only.
  if (!interactiveInput && process.stdin.isTTY && process.stdout.isTTY) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  let history = journal.messages;
  let activeController;
  let sigtermRequested = false;
  const { createTuiInterruptHandler } = await import('./tui/interrupt.js');
  const onTuiInterrupt = createTuiInterruptHandler({
    getActiveController: () => activeController,
    onCancelMessage: () => tui?.pushSystemMessage(t(locale, 'pressCtrlCAgain')),
    onExit: () => {
      process.exitCode = 130;
      tui?.close(130);
    },
  });
  onSigterm = () => {
    // Pinned original ShellCommandImpl delegates cancellation to the active
    // abort signal, whose Bash process owner kills its entire process tree.
    // Do not let Node's default SIGTERM exit orphan a still-running Bash.
    sigtermRequested = true;
    process.exitCode = 143;
    if(activeController && !activeController.signal.aborted) {
      const error = new Error('Terminated by SIGTERM.');
      error.name = 'AbortError';
      activeController.abort(error);
    }
    // Abort an outstanding readline question as well as closing the
    // interface; readline/promises must release the waiting interactive loop.
    const questionError = new Error('Terminated by SIGTERM.');
    questionError.name = 'AbortError';
    interactiveQuestionController?.abort(questionError);
    rl?.close();
    tui?.close(143);
  };
  // Port 2.1.88 hooks/useExitOnCtrlCD.ts + useDoublePress.ts:
  // cancel an active turn first; when idle, require a second Ctrl+C within
  // the original 800ms window before ending the interactive session.
  const DOUBLE_PRESS_TIMEOUT_MS = 800;
  let lastIdleInterruptAt = 0;
  const armIdleInterrupt = now => {
    lastIdleInterruptAt = now;
    // 2.1.88 useTextInput.ts clears a non-empty prompt on the first
    // Ctrl+C, then leaves the 800ms double-press window armed for exit.
    // Use readline's public key injection rather than mutating its
    // internal line/cursor fields so the terminal is redrawn consistently.
    if (rl.line.length > 0) {
      rl.write(null, { ctrl: true, name: 'a' });
      rl.write(null, { ctrl: true, name: 'k' });
      // readline retains historyIndex when a recalled line is deleted.
      // 2.1.88 useTextInput calls onHistoryReset on this first press, so
      // return Node's history cursor to the newest entry as well.
      rl.historyIndex = -1;
    }
    process.stderr.write('Press Ctrl+C again to exit.\n');
  };
  onSigint = () => {
    if (tui) {
      onTuiInterrupt();
      return;
    }
    if (activeController && !activeController.signal.aborted) {
      lastIdleInterruptAt = 0;
      const error = new Error('Interrupted by user.');
      error.name = 'AbortError';
      activeController.abort(error);
      return;
    }
    const now = Date.now();
    if (activeController) {
      // 2.1.88 CancelRequestHandler stops claiming Ctrl+C once the active
      // signal is aborted. The focused TextInput then treats the next key as
      // its first idle press. Arm that press, but never close readline while
      // the cancellation owner is still settling; a later press after cleanup
      // may complete the double-press exit.
      if (rl && !rl.closed &&
        (lastIdleInterruptAt === 0 || now - lastIdleInterruptAt > DOUBLE_PRESS_TIMEOUT_MS)) {
        armIdleInterrupt(now);
      }
      return;
    }
    if (!rl || rl.closed) return;
    if (lastIdleInterruptAt !== 0 && now - lastIdleInterruptAt <= DOUBLE_PRESS_TIMEOUT_MS) {
      interactiveQuestionController?.abort(new Error('Interrupted by user.'));
      rl.close();
      process.exitCode = 130;
    } else {
      armIdleInterrupt(now);
    }
  };
  process.on('SIGINT', onSigint);
  // readline owns raw-mode Ctrl+C on a TTY (including Windows ConPTY).
  // It emits SIGINT on the interface instead of the process. Without this
  // listener Ctrl+C closes input while the active model keeps streaming.
  rl?.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  loop.on('toolCallStarted', ({ toolName }) => {
    if (options.allowEdits && (toolName === 'Write' || toolName === 'Edit')) {
      const notice = t(locale, 'permissionAutoApproved', { tool: toolName });
      if (tui) tui.pushSystemMessage(notice);
      else process.stderr.write(notice + '\n');
    }
    const notice = t(locale, 'toolStarted', { tool: toolName });
    if (tui) tui.setStatus(notice);
    else process.stderr.write('\n' + notice + '\n');
  });
  loop.on('toolCallFinished', ({ toolName, isError, denied }) => {
    if (isError) {
      const notice = t(locale, 'toolFailed', {
        tool: toolName,
        status: denied ? t(locale, 'toolDenied') : t(locale, 'toolError'),
      });
      if (tui) tui.pushSystemMessage(notice);
      else process.stderr.write(notice + '\n');
    }
    if (tui) tui.setStatus(tui.getSnapshot().busy ? t(locale, 'tuiWorking') : t(locale, 'tuiReady'));
  });

  const reportInteractiveError = message => {
    if (tui) tui.pushSystemMessage(t(locale, 'errorPrefix') + ' ' + localizeCliMessage(
      message instanceof Error ? message.message : String(message), locale));
    else printLocalizedError(message);
  };

  const runPrompt = async (text, { plain = false } = {}) => {
    if(sigtermRequested)return 143;
    if(journal.needsToolReconciliation) {
      reportInteractiveError(journal.needsToolContextReview
      ? 'Session contains completed tool results but failed Hook/native context normalization. Inspect the preserved results and Hook side effects before continuing; automatic replay is unsafe.'
      : 'Session contains an unfinished tool batch. Inspect side effects and reconcile the session before continuing; automatic replay is unsafe.');
      return 2;
    }
    activeController = new AbortController();
    if (tui) {
      tui.setBusy(true);
      tui.setStatus(t(locale, 'tuiWorking'));
      if (text !== undefined) tui.addMessage('user', text);
      if (!plain) tui.beginAssistantMessage();
    } else if (!plain) {
      process.stdout.write(t(locale, 'assistantPrompt'));
    }
    const onTextDelta = ({ text: delta }) => {
      if (tui) tui.appendAssistantText(delta);
      else process.stdout.write(delta);
    };
    // Once a model-requested tool turn has finished, its effects may already
    // be on disk. If the NEXT model stream fails, retaining the completed
    // assistant/tool_result pair prevents a retry from redoing that work.
    let committedHistory;
    const onTurnFinished = ({ committedMessages }) => {
      if (committedMessages) committedHistory = committedMessages;
    };
    const onContextCompacted = ({ committedMessages, beforeCount, afterCount }) => {
      committedHistory = committedMessages;
      const notice = t(locale, 'contextCompacted', {
        before: beforeCount,
        after: afterCount,
      });
      if (tui) tui.setStatus(notice);
      else process.stderr.write(notice + '\n');
    };
    loop.on('textDelta', onTextDelta);
    loop.on('turnFinished', onTurnFinished);
    loop.on('contextCompacted', onContextCompacted);
    try {
      if (text !== undefined) {
        // The old sessionStorage.ts insertMessageChain() persists a user
        // message before model streaming, even when the provider later
        // fails. Commit this exact model input first, without inventing
        // another message or altering AgentLoop's ToolUseContext handoff.
        await journal.append({
          messages: [...history, {role:'user',content:text}], kind:'input',
        });
      }
      const result = await loop.run({
        messages: history,
        ...(text === undefined ? {} : { input: text }),
        signal: activeController.signal,
      });
      history = result.messages;
      if (tui) {
        tui.finishAssistantMessage();
        tui.setBusy(false);
        tui.setStatus(t(locale, 'tuiReady'));
      } else {
        process.stdout.write('\n');
      }
      if(sigtermRequested)return 143;
      if (result.stopReason === 'max_tokens') {
        reportInteractiveError('Model output reached --max-tokens before finishing. Increase --max-tokens or continue the conversation.');
        return 1;
      }
      if (result.stopReason === 'max_turns') {
        reportInteractiveError('Agent reached --max-turns (' + options.maxTurns + ') without a final response. Increase --max-turns or continue the conversation.');
        return 1;
      }
      return 0;
    } catch (error) {
      if (tui) tui.finishAssistantMessage();
      else process.stdout.write('\n');
      // 2.1.88 sessionStorage.ts commits the actual message chain, not the
      // last Query turnFinished event. Query can fsync a LocalShellTask
      // <task_notification> AFTER emitting turnFinished and BEFORE a failed
      // provider request. Reverting to committedHistory here drops that
      // durable message and makes the next interactive input a non-prefix
      // session rewrite. The journal is the authoritative last committed
      // history for ALL errors, including compact roots and abort races.
      const priorHistoryLength=history.length;
      history=journal.messages;
      if(journal.needsToolContextReview) {
        // Tool mapping completed, but Hook/native context normalization
        // failed. Preserve the confirmed final tool result without pretending
        // that the failed post-tool context can be safely replayed.
        if(interactiveInput) {
          if (tui) tui.pushSystemMessage(t(locale, 'recoveryNeedsReview'));
          else process.stderr.write(t(locale, 'recoveryNeedsReview') + '\n');
        }
      } else if (committedHistory) {
        // The erroring model response is NOT committed. Keep every preceding
        // durable transition, including task notifications since the last
        // completed tool batch. Never reconstruct history from an older event.
        if (interactiveInput) {
          if (tui) tui.pushSystemMessage(t(locale, 'recoveryToolResults'));
          else process.stderr.write(t(locale, 'recoveryToolResults') + '\n');
        }
      } else if (history.length > priorHistoryLength) {
        // A provider failure before its first complete response must not
        // strand a durable user prompt outside the interactive history.
        if (interactiveInput) {
          if (tui) tui.pushSystemMessage(t(locale, 'recoveryPrompt'));
          else process.stderr.write(t(locale, 'recoveryPrompt') + '\n');
        }
      }
      if (!tui || !activeController.signal.aborted) reportInteractiveError(error);
      return sigtermRequested ? 143 : activeController.signal.aborted ? 130 : 1;
    } finally {
      if (tui) {
        tui.setBusy(false);
        if (!sigtermRequested) tui.setStatus(t(locale, 'tuiReady'));
      }
      loop.off('textDelta', onTextDelta);
      loop.off('turnFinished', onTurnFinished);
      loop.off('contextCompacted', onContextCompacted);
      activeController = undefined;
    }
  };

    if (!interactiveInput) {
      return await runPrompt(initialInputCommitted ? undefined : (prompt.length ? prompt : undefined), { plain: options.print });
    }

    // The source /model implementation persists the model override before
    // changing the active provider. Both Ink and readline use this owner.
    const notifyInteractive = message => {
      if (tui) tui.pushSystemMessage(message);
      else process.stderr.write(message + '\n');
    };
  const handleModelCommand=async command=>{
      const match=/^\/model(?:\s+(.*))?$/i.exec(command);
      if(!match)return false;
      const argument=(match[1]??'').trim();
      if(!argument||['--current','current','--info','info'].includes(argument)){
        notifyInteractive(t(locale, 'modelCurrent', { model: model.model, setting: activeModelSetting }));
        return true;
      }
      if(['--help','-h','help'].includes(argument)){
        notifyInteractive(t(locale, 'modelUsage'));
        return true;
      }
      try{
        const setting=argument==='default'?requestedModel:argument;
        // Same parser as --model: never reinterpret OpenAI/DeepSeek IDs,
        // and reject unsupported first-party [1m] before touching state.
        const resolved=argument==='default'?startupModel:
          resolveOriginalCliModel({
            provider,model:setting,permissionMode:permissionContext.mode,env,
          });
        // Validate the candidate first, then write its versioned witness
        // under the original session lock. A failed fsync can NEVER make
        // an uncommitted model change effective in the current process.
        if(typeof resolved!=='string'||!resolved.trim())
          throw new TypeError('Model identifier cannot be empty.');
        try{
          await journal.appendModelOverride({
            provider,setting:argument==='default'?null:setting,
          });
        }catch(error){
          modelJournalFailure=true;
          reportInteractiveError('Session model checkpoint failed; stopping to prevent an unrecorded model change: '+
            (error instanceof Error?error.message:String(error)));
          rl?.close();
          tui?.close(2);
          return true;
        }
        model.setModel(resolved);
        activeModelSetting=setting;
        tui?.setModel(model.model);
        notifyInteractive(t(locale, 'modelSet', { model: model.model }));
      }catch(error){
        notifyInteractive(t(locale, 'modelUnchanged', { reason: error instanceof Error ? error.message : String(error) }));
      }
      return true;
    };
    const handleInteractiveInput = async text => {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '/exit' || trimmed === '/quit') {
        tui?.close(0);
        rl?.close();
        return;
      }
      if (trimmed === '/help') {
        const help = getHelp(locale, VERSION);
        if (tui) tui.pushSystemMessage(help);
        else process.stdout.write(help);
        return;
      }
      if (trimmed === '/language' || trimmed.startsWith('/language ')) {
        const rawLanguage = trimmed.slice('/language'.length).trim();
        if (!rawLanguage) {
          notifyInteractive(t(locale, 'languageCurrent', {
            language: languageLabel(locale, languagePreference),
          }) + '\n' + t(locale, 'languageUsage'));
          return;
        }
        const nextPreference = normalizeLanguagePreference(rawLanguage);
        if (!nextPreference) {
          notifyInteractive(t(locale, 'languageInvalid') + '\n' + t(locale, 'languageUsage'));
          return;
        }
        try {
          await saveLanguagePreference(nextPreference, { env });
          languagePreference = nextPreference;
          locale = resolveLanguage(nextPreference, env);
          tui?.setLocale(locale);
          notifyInteractive(t(locale, 'languageSet', {
            language: languageLabel(locale, languagePreference),
          }));
        } catch (error) {
          notifyInteractive(t(locale, 'languageSaveFailed', {
            reason: error instanceof Error ? error.message : String(error),
          }));
        }
        return;
      }
      if (!trimmed) return;
      if (await handleModelCommand(trimmed)) return;
      const status = await runPrompt(trimmed);
      if (status === 130) notifyInteractive(t(locale, 'interrupted'));
    };

    // Only bootstrap failure may fall back to readline. A real model/tool
    // error after Ink starts must stay in the existing AgentLoop/recovery path.
    try {
      const { startAgentTui } = await import('./tui/entry.js');
      tui = await startAgentTui({
        locale,
        model: model.model,
        permissionMode: permissionContext.mode,
        onSubmit: handleInteractiveInput,
        onInterrupt: onTuiInterrupt,
      });
      tui.setStatus(t(locale, 'tuiReady'));
    } catch (error) {
      if (tui) {
        tui.close(1);
        await tui.waitUntilExit();
        tui = undefined;
      }
      printLocalizedError('Could not start the original Ink TUI; falling back to the readline interface: ' +
        (error instanceof Error ? error.message : String(error)));
      rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', onSigint);
    }

    if (tui) {
      if (prompt) {
        // The startup user prompt is already fsynced by the current core.
        // Display it in Ink without inserting a duplicate model input.
        tui.addMessage('user', prompt);
        const status = await runPrompt(initialInputCommitted ? undefined : prompt);
        if (status === 130) tui.pushSystemMessage(t(locale, 'interrupted'));
      }
      if (!sigtermRequested && !modelJournalFailure) {
        tui.setInputEnabled(true);
        await tui.waitUntilExit();
      }
      return sigtermRequested ? 143 : modelJournalFailure ? 2 : tui.getExitCode();
    }

    process.stderr.write(t(locale, 'interactiveStarted') + '\n');
    if (prompt) {
      const status = await runPrompt(initialInputCommitted ? undefined : prompt);
      if (status === 130) process.stderr.write(t(locale, 'interrupted') + '\n');
    }
    while (rl && !rl.closed && !sigtermRequested && !modelJournalFailure) {
      let text;
      interactiveQuestionController = new AbortController();
      try {
        text = await rl.question(t(locale, 'userPrompt'), {
          signal: interactiveQuestionController.signal,
        });
      } catch {
        break;
      } finally {
        interactiveQuestionController = undefined;
      }
      await handleInteractiveInput(text);
    }
    return sigtermRequested ? 143 : modelJournalFailure ? 2 : 0;
  } finally {
    // SIGINT may already have registered when SIGTERM registration or
    // readline setup throws; never leave a partial listener behind.
    if(onSigint)process.off('SIGINT', onSigint);
    if(onSigterm)process.off('SIGTERM', onSigterm);
    rl?.off('SIGINT', onSigint);
    interactiveQuestionController?.abort(new Error('CLI is closing.'));
    if (tui) {
      tui.close(sigtermRequested ? 143 : modelJournalFailure ? 2
        : process.exitCode === 130 ? 130 : 0);
      await tui.waitUntilExit();
    }
    rl?.close();
    try {
      // 2.1.88 LocalShellTask kills agent-owned shells on exit, and
      // 2.1.304 waits for pendingKillBackstops during shutdown. Do this
      // BEFORE releasing the durable session lock, including exceptional
      // setup, normal completion and SIGTERM paths.
      try {await taskManager?.killShellTasksForAgent();}
      finally {await cleanupLiveShellCommands();}
    } finally {
      await journal.close();
    }
  }
}

// npm installs the bin as a symlink. Node resolves import.meta.url to its
// real path while process.argv[1] may retain the symlink path.
const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().then((code) => {
    if (Number.isInteger(code) && code !== 0) process.exitCode = code;
  }).catch(async (error) => {
    let locale = 'en';
    try { locale = (await loadLanguagePreference()).locale; } catch {}
    printError(error, locale);
    process.exitCode = 1;
  });
}
