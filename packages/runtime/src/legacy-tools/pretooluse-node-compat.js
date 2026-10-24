/**
 * Node-only dependency closure for methods transplanted verbatim from
 * 2.1.88 services/tools/toolHooks.ts. The original hooks.ts is preserved
 * under legacy-original; only synchronous command hooks are adapted here.
 *
 * Unsupported native Hook types MUST be rejected when settings are loaded;
 * do not silently substitute a simplified allow decision for them.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aggregateHookResults } from './pretooluse-hook-aggregation.js';

const MAX_HOOK_OUTPUT_BYTES = 128 * 1024;
const MAX_HOOK_DURATION_MS = 30000;
const MAX_HOOK_SETTINGS_BYTES = 1024 * 1024;

export function createAttachmentMessage(attachment) {
  return { type: 'attachment', attachment };
}
export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}
export function getRuleBehaviorDescription(behavior) {
  return ({ allow: 'allowed', deny: 'denied', ask: 'requires permission for' })[behavior] ?? behavior;
}
export function getPreToolHookBlockingMessage(hookName, blockingError) {
  const reason = typeof blockingError === 'string' ? blockingError :
    blockingError?.blockingError ?? 'Blocked by hook';
  return hookName + ' hook blocked tool use: ' + reason;
}
export async function checkRuleBasedPermissions(tool, input, toolUseContext) {
  // Source resolver calls the real permissions.ts checkRuleBasedPermissions
  // *after* Hook allow. The Node host provides the same mandatory checks
  // through its active policy; only a generic default prompt is bypassable.
  const candidate = await toolUseContext.checkRuleBasedPermissions(tool, input);
  if (!candidate || candidate.behavior === 'allow') return null;
  if (candidate.behavior === 'deny') return candidate;
  if (candidate.behavior === 'ask' && (
    candidate.decisionReason?.type === 'rule' ||
    candidate.decisionReason?.type === 'safetyCheck' ||
    candidate.forceApproval === true
  )) return candidate;
  // Only first-party CLI default write/bash prompt can be bypassed by a
  // *trusted opt-in* Hook allow. User-provided policies remain authoritative.
  if (candidate.behavior === 'ask' &&
      toolUseContext.trustedCliDefaultPermission === true &&
      (candidate.reason === 'This tool modifies workspace files.' ||
       candidate.reason === 'This command executes a shell process.')) {
    return null;
  }
  return candidate;
}

// Original hooks.ts matchesPattern() with original parser aliases,
// including exact, pipe and regex matchers.
export function matchesPattern(matchQuery, matcher) {
  if (!matcher || matcher === '*') return true;
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    const patterns = matcher.split('|').map(name => normalizeLegacyToolName(name.trim()));
    return patterns.includes(matchQuery);
  }
  try {
    const regex = new RegExp(matcher);
    if (regex.test(matchQuery)) return true;
    for (const legacy of getLegacyToolNames(matchQuery)) {
      if (regex.test(legacy)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
const aliases = { Task: 'Agent', KillShell: 'TaskStop', AgentOutputTool: 'TaskOutput', BashOutputTool: 'TaskOutput' };
function normalizeLegacyToolName(name) { return aliases[name] ?? name; }
function getLegacyToolNames(canonical) { return Object.entries(aliases).filter(([,n]) => n === canonical).map(([n]) => n); }

const SUPPORTED_TOOL_HOOK_EVENTS = Object.freeze([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
]);

/** Original hooks.ts event/matcher command configuration shape.
 * Explicit operator-selected --hooks-file is required; no repo auto trust. */
export async function loadToolHookSettings(file) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new TypeError('Hooks settings file is required.');
  }
  const name = resolve(file);
  const text = await readFile(name, { encoding: 'utf8' });
  if (Buffer.byteLength(text, 'utf8') > MAX_HOOK_SETTINGS_BYTES) {
    throw new RangeError('Hook settings exceed 1 MiB.');
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !parsed.hooks || typeof parsed.hooks !== 'object' ||
      Array.isArray(parsed.hooks)) {
    throw new TypeError('Hook settings require a hooks event object.');
  }
  const events = Object.keys(parsed.hooks);
  if (!events.length || events.some(event => !SUPPORTED_TOOL_HOOK_EVENTS.includes(event))) {
    throw new Error('Only PreToolUse, PostToolUse and PostToolUseFailure command hooks are supported.');
  }
  const result = {};
  for (const event of SUPPORTED_TOOL_HOOK_EVENTS) {
    const groups = parsed.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new TypeError('Malformed ' + event + ' hook matcher list.');
    const commands = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object' ||
          typeof group.matcher !== 'string' || !Array.isArray(group.hooks)) {
        throw new TypeError('Malformed ' + event + ' hook matcher.');
      }
      for (const hook of group.hooks) {
        if (!hook || hook.type !== 'command' || typeof hook.command !== 'string' ||
            !hook.command.trim() || hook.async || hook.asyncRewake || hook.shell) {
          throw new TypeError('Only synchronous ' + event + ' command hooks are supported.');
        }
        if (hook.timeout !== undefined &&
          (!Number.isSafeInteger(hook.timeout) || hook.timeout < 1 || hook.timeout > 30)) {
          throw new RangeError('Hook timeout must be 1–30 seconds.');
        }
        commands.push(Object.freeze({ ...hook, matcher: group.matcher }));
      }
    }
    result[event] = Object.freeze(commands);
  }
  return Object.freeze(result);
}

// Retain the existing adapter API for CLI/test code that uses only PreToolUse.
export async function loadPreToolUseHookSettings(file) {
  const settings = await loadToolHookSettings(file);
  return settings.PreToolUse;
}

function abortHookProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
  } else {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

/**
 * Node port of hooks.ts execCommandHook() synchronous branch:
 * shell selection, stdin JSON + newline, bounded stdout/stderr, exit code 2,
 * JSON response, timeouts, abort and process cleanup.
 */
export async function execCommandHook(command, hookInput, workspace, signal, timeoutMs = MAX_HOOK_DURATION_MS) {
  if (signal?.aborted) throw signal.reason ?? new Error('Hook aborted.');
  const isWindows = process.platform === 'win32';
  // Historical Windows command hooks use Git Bash rather than cmd.exe.
  // Require an explicit git-bash path; unsupported shells fail closed.
  const defaultGitBash = join(process.env.ProgramFiles || 'C:\\Program Files',
    'Git', 'bin', 'bash.exe');
  const configuredBash = process.env.AGENT_CIL_GIT_BASH ||
    (existsSync(defaultGitBash) ? defaultGitBash : null);
  if (isWindows && !configuredBash) {
    throw new Error('Windows PreToolUse requires Git Bash (set AGENT_CIL_GIT_BASH).');
  }
  const child = spawn(command, [], {
    shell: isWindows ? configuredBash : true,
    cwd: workspace,
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspace },
    detached: !isWindows, windowsHide: true, stdio: ['pipe','pipe','pipe'],
  });
  let out = '', err = '', overflow = false, timedOut = false;
  const append = (value, key) => {
    if (key === 'stdout') out += value;
    else err += value;
    if (Buffer.byteLength(out) + Buffer.byteLength(err) > MAX_HOOK_OUTPUT_BYTES) {
      overflow = true;
      abortHookProcess(child);
    }
  };
  child.stdin.on('error', () => {}); // Child can exit before stdin flushes.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => append(value, 'stdout'));
  child.stderr.on('data', value => append(value, 'stderr'));
  const onAbort = () => abortHookProcess(child);
  signal?.addEventListener('abort', onAbort, { once: true });
  const watchdog = setTimeout(() => { timedOut = true; abortHookProcess(child); }, timeoutMs);
  try {
    child.stdin.end(JSON.stringify(hookInput) + '\n');
    const status = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, termSignal) => done({ code, termSignal }));
    });
    if (signal?.aborted) throw signal.reason ?? new Error('Hook aborted.');
    if (overflow) throw new RangeError('Hook output exceeds 128 KiB.');
    if (timedOut) throw new Error('Hook command timed out.');
    return { stdout: out, stderr: err, status: status.code };
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null) abortHookProcess(child);
  }
}

function parseOriginalHookJSON(stdout) {
  const text = stdout.trim();
  if (!text.startsWith('{')) return null; // Original: plain-text hook output.
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hook JSON output.');
  const decision = value.hookSpecificOutput?.hookEventName === 'PreToolUse'
    ? value.hookSpecificOutput.permissionDecision
    : (value.decision === 'approve' ? 'allow' : value.decision === 'block' ? 'deny' : undefined);
  if (decision !== undefined && !['allow','ask','deny'].includes(decision)) {
    throw new Error('Invalid hook permissionDecision.');
  }
  const updatedInput = value.hookSpecificOutput?.updatedInput;
  if (updatedInput !== undefined &&
      (!updatedInput || typeof updatedInput !== 'object' || Array.isArray(updatedInput))) {
    throw new Error('Invalid Hook updatedInput: expected object.');
  }
  if (value.continue !== undefined && typeof value.continue !== 'boolean') {
    throw new Error('Invalid Hook continue flag.');
  }
  return {
    permissionBehavior: decision,
    updatedInput,
    hookPermissionDecisionReason: value.hookSpecificOutput?.permissionDecisionReason ?? value.reason,
    preventContinuation: value.continue === false,
    stopReason: value.stopReason,
    blockingError: decision === 'deny' ? { blockingError: value.reason || 'Blocked by hook' } : undefined,
    additionalContexts: value.hookSpecificOutput?.additionalContext ? [value.hookSpecificOutput.additionalContext] : undefined,
  };
}

/** Original executePreToolHooks(...) generator contract.
 * Actual command spawning belongs in the Node platform adapter above.
 * Hooks must be explicitly loaded from an operator-selected file.
 */
export async function* executePreToolHooks(toolName, toolUseID, toolInput,
    toolUseContext, permissionMode, signal) {
  const hooks = toolUseContext.preToolUseHooks ?? [];
  const matching = hooks.filter(h => matchesPattern(toolName, h.matcher));
  if (!matching.length) return;
  const hookInput = {
    session_id: toolUseContext.sessionId || '',
    transcript_path: toolUseContext.transcriptPath || '',
    cwd: toolUseContext.workspace,
    permission_mode: permissionMode,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  };
  // Source executeHooks starts all matching commands in parallel; preserve
  // the config-order result stream after independent command completion.
  const outcomes = matching.map(hook => execCommandHook(hook.command, hookInput,
    toolUseContext.workspace, signal, (hook.timeout ?? 30) * 1000)
    .then(commandResult => {
      if (commandResult.status === 2) {
        return { blockingError: {
          blockingError: commandResult.stderr.trim() || commandResult.stdout.trim() ||
            'Blocked by PreToolUse command hook',
        }};
      }
      if (commandResult.status !== 0) return { message: createAttachmentMessage({
        type: 'hook_error_during_execution',
        content: 'Hook command exited ' + commandResult.status,
        hookEvent: 'PreToolUse',
      }) };
      const output = parseOriginalHookJSON(commandResult.stdout);
      return output || {};
    }).catch(error => ({
      blockingError: { blockingError: formatError(error) },
      ...(signal?.aborted ? { preventContinuation: true } : {}),
    })));
  // Original hooks.ts executeHooks aggregates all command decisions with
  // deny > ask > allow before emitting each permissionBehavior update.
  // The previous Node adapter yielded each raw hook result and incorrectly
  // let a trailing allow undo an earlier deny.
  for await (const aggregate of aggregateHookResults(outcomes, signal)) {
    yield aggregate;
  }
  if (signal?.aborted) {
    yield { message: createAttachmentMessage({
      type: 'hook_cancelled', hookEvent: 'PreToolUse',
    }) };
  }
}
