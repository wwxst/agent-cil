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

function uncertainHookProcessTree(child, reason, cause) {
  // Native 2.1.304 Bash/process cleanup treats a failed tree-kill as a
  // fatal uncertainty, not as success. Hook command processes are equally
  // capable of leaving descendants with live side effects. Do the same
  // bounded best-effort fallback, but NEVER mistake it for proof of cleanup.
  try { child.kill('SIGKILL'); } catch {}
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  const error = new Error(
    'Native Hook process-tree cleanup could not be confirmed: ' + reason +
    '. Unowned descendants may remain.',
    { cause },
  );
  error.name = 'ProcessTreeCleanupError';
  return error;
}

function abortHookProcess(child) {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolveKill, rejectKill) => {
      let settled = false;
      let watchdog;
      const finish = (successful, reason, cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (successful) resolveKill();
        else rejectKill(uncertainHookProcessTree(child, reason, cause));
      };
      try {
        // Exact 2.1.304 mechanism: argv-only System32 tree terminator. A
        // repo-local taskkill executable must never be resolved from PATH.
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { cwd: undefined, shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', error =>
          finish(false, error.code || error.message, error));
        killer.once('close', (code, signal) =>
          finish(code === 0, signal
            ? 'taskkill signal ' + signal : 'taskkill exit ' + String(code)));
        // 2.1.304 records pending kill backstops. The current Node Hook
        // must bound a stuck taskkill worker instead of holding the session
        // lock indefinitely while descendants may remain alive.
        watchdog = setTimeout(() => {
          try { killer.kill('SIGKILL'); } catch {}
          finish(false, 'taskkill exceeded 5s');
        }, 5000);
      } catch (error) {
        finish(false, error instanceof Error ? error.message : String(error), error);
      }
    });
  }
  try {
    // PreToolUse commands are spawned as POSIX process-group leaders.
    process.kill(-child.pid, 'SIGKILL');
    return Promise.resolve();
  } catch (error) {
    if (error?.code === 'ESRCH') {
      // No group is left to signal (normal exit-vs-abort race).
      return Promise.resolve();
    }
    // A direct-child kill is not equivalent to a process-group kill.
    return Promise.reject(uncertainHookProcessTree(
      child, error?.code || (error instanceof Error ? error.message : String(error)), error));
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
  let killTask;
  let cleanupFailure;
  let rejectCleanupFailure;
  const cleanupFailed = new Promise((_, reject) => { rejectCleanupFailure = reject; });
  // Observe the fatal branch immediately: a timeout/AbortSignal may start
  // termination well before the main ChildProcess 'close' listener settles.
  void cleanupFailed.catch(() => {});
  const terminate = () => {
    if (!killTask) {
      killTask = abortHookProcess(child).catch(error => {
        cleanupFailure = error;
        rejectCleanupFailure(error);
      });
    }
    return killTask;
  };
  const append = (value, key) => {
    if (key === 'stdout') out += value;
    else err += value;
    if (Buffer.byteLength(out) + Buffer.byteLength(err) > MAX_HOOK_OUTPUT_BYTES) {
      overflow = true;
      void terminate();
    }
  };
  child.stdin.on('error', () => {}); // Child can exit before stdin flushes.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => append(value, 'stdout'));
  child.stderr.on('data', value => append(value, 'stderr'));
  const onAbort = () => { void terminate(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const watchdog = setTimeout(() => { timedOut = true; void terminate(); }, timeoutMs);
  try {
    child.stdin.end(JSON.stringify(hookInput) + '\n');
    const status = await Promise.race([
      new Promise((done, fail) => {
        child.once('error', fail);
        child.once('close', (code, termSignal) => done({ code, termSignal }));
      }),
      cleanupFailed,
    ]);
    if (signal?.aborted) throw signal.reason ?? new Error('Hook aborted.');
    if (overflow) throw new RangeError('Hook output exceeds 128 KiB.');
    if (timedOut) throw new Error('Hook command timed out.');
    return { stdout: out, stderr: err, status: status.code };
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', onAbort);
    // Original ShellCommand.cleanup() does not declare a cancelled tool
    // complete while child cleanup is still pending. In particular, await
    // the Windows taskkill /T worker before the Hook's turn is released.
    if (child.exitCode === null && child.signalCode === null) void terminate();
    if (killTask) await killTask;
    // If POSIX group-kill or Windows taskkill /T failed, do not downgrade
    // the uncertainty to an ordinary Hook timeout/cancellation attachment.
    if (cleanupFailure) throw cleanupFailure;
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
