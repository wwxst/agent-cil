/**
 * Node platform dependency closure for original 2.1.88 toolHooks.ts
 * runPostToolUseHooks/runPostToolUseFailureHooks. The original generators
 * themselves remain source-transplanted in posttooluse-core.js.
 *
 * Synchronous command Hook execution reuses the existing PreToolUse adapter
 * (Git Bash on Windows, JSON stdin, bounded output/time, process-tree abort).
 * SDK callbacks, async/background and HTTP Hooks are not silently run.
 */
import {
  createAttachmentMessage, execCommandHook, matchesPattern, formatError,
} from './pretooluse-node-compat.js';

export { createAttachmentMessage, formatError };

function parsePostToolHookOutput(stdout, expectedEvent) {
  const raw = stdout.trim();
  if (!raw || raw[0] !== '{') {
    return raw ? { message: createAttachmentMessage({
      type: 'hook_success', hookEvent: expectedEvent, content: raw,
    }) } : {};
  }
  const json = JSON.parse(raw);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('Hook result JSON must be an object.');
  }
  const specific = json.hookSpecificOutput;
  if (specific !== undefined &&
      (!specific || typeof specific !== 'object' || Array.isArray(specific) ||
       specific.hookEventName !== expectedEvent)) {
    throw new Error('Hook returned incorrect event name: expected ' + expectedEvent);
  }
  if (json.decision !== undefined &&
      !['approve','block'].includes(json.decision)) {
    throw new TypeError('Unexpected Hook decision value.');
  }
  if (json.continue !== undefined && typeof json.continue !== 'boolean') {
    throw new TypeError('Hook continue must be a boolean.');
  }
  if (json.stopReason !== undefined && typeof json.stopReason !== 'string') {
    throw new TypeError('Hook stopReason must be text.');
  }
  if (specific?.updatedMCPToolOutput !== undefined) {
    // Model-result remapping of MCP-only output is not installed in this CLI.
    throw new Error('MCP PostToolUse output rewriting requires original MCP integration.');
  }
  if (specific?.permissionDecision !== undefined || specific?.updatedInput !== undefined) {
    // These fields are for PreToolUse only.
    throw new Error('PostToolUse cannot change tool permission/input.');
  }
  const context = specific?.additionalContext;
  if (context !== undefined && (typeof context !== 'string' || context.length > 128000)) {
    throw new TypeError('Hook additionalContext must be bounded text.');
  }
  const blocking = json.decision === 'block'
    ? { blockingError: json.reason || 'Blocked by Hook after tool execution' }
    : undefined;
  return {
    ...(blocking ? { blockingError: blocking } : {}),
    ...(json.continue === false
      ? { preventContinuation: true, stopReason: json.stopReason } : {}),
    ...(context ? { additionalContexts: [context] } : {}),
    ...(typeof json.systemMessage === 'string' && json.systemMessage
      ? { message: createAttachmentMessage({
          type: 'hook_system_message', content: json.systemMessage,
          hookEvent: expectedEvent,
        }) } : {}),
  };
}

async function* executeConfiguredPostHooks(
  event, toolName, toolUseID, input, toolUseContext, signal,
) {
  const matching = (toolUseContext.toolHooks?.[event] || [])
    .filter(hook => matchesPattern(toolName, hook.matcher));
  if (!matching.length) return;
  const hookInput = {
    session_id: toolUseContext.sessionId || '',
    transcript_path: toolUseContext.transcriptPath || '',
    cwd: toolUseContext.workspace,
    permission_mode: toolUseContext.getAppState().toolPermissionContext.mode,
    hook_event_name: event,
    tool_name: toolName,
    tool_use_id: toolUseID,
    ...input,
  };
  // Original executeHooks runs matching command hooks concurrently and
  // emits completion results in matched order. Keep concurrent execution.
  const outcomes = matching.map(hook =>
    execCommandHook(hook.command, hookInput, toolUseContext.workspace,
      signal, (hook.timeout ?? 30) * 1000)
      .then(result => {
        if (result.status === 2) return {
          blockingError: { blockingError: result.stderr.trim() ||
            'Hook command blocked execution', command: hook.command },
        };
        if (result.status !== 0) return { message: createAttachmentMessage({
          type: 'hook_non_blocking_error',
          content: result.stderr.trim() || 'Hook exited ' + result.status,
          hookEvent: event,
        }) };
        return parsePostToolHookOutput(result.stdout, event);
      })
      .catch(error => ({ message: createAttachmentMessage({
        type: signal?.aborted ? 'hook_cancelled' : 'hook_error_during_execution',
        content: formatError(error), hookEvent: event,
      }) }))
  );
  for (const pending of outcomes) {
    const outcome = await pending;
    yield outcome;
    if (signal?.aborted) return;
  }
}

// 2.1.88 hooks.ts executePostToolHooks() adapter to its executeHooks()
// command-host branch. The original exported method body is retained in
// ../legacy-original/hooks.ts; the event input fields match its contract.
export async function* executePostToolHooks(
  toolName, toolUseID, toolInput, toolResponse,
  toolUseContext, permissionMode, signal,
) {
  yield* executeConfiguredPostHooks('PostToolUse', toolName, toolUseID,
    { tool_input: toolInput, tool_response: toolResponse },
    toolUseContext, signal);
}

export async function* executePostToolUseFailureHooks(
  toolName, toolUseID, toolInput, error, toolUseContext,
  isInterrupt, permissionMode, signal,
) {
  yield* executeConfiguredPostHooks('PostToolUseFailure', toolName, toolUseID,
    { tool_input: toolInput, error, is_interrupt: isInterrupt },
    toolUseContext, signal);
}
