import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { ToolRegistry } from './tool-registry.js';
import { defaultDenyPermission } from './permissions.js';
import { invokeToolCallAndMapResult } from './legacy-tools/tool-execution.js';
import { getOriginalPermissionContentBlocks } from './legacy-tools/original-permission-result-content.js';
import { prepareObservableToolInput, restoreToolCallInput } from './legacy-tools/tool-call-input.js';
import { runPreToolUseHooks, resolveHookPermissionDecision } from './legacy-tools/pretooluse-core.js';
import { runPostToolUseHooks, runPostToolUseFailureHooks } from './legacy-tools/posttooluse-core.js';
import { query } from './legacy-query/query.js';
import { normalizeToolHookAttachmentsForAPI } from './legacy-query/normalize-hook-attachments.js';
export { ModelProtocolError } from './legacy-query/query.js';
import { resolveToolSpecificPermission } from './legacy-permissions/tool-specific-permission.js';
import { originalCanUseNestedTool } from './legacy-permissions/nested-can-use-tool.js';

const MAX_PERMISSION_INPUT_REWRITES = 8;
const EARLY_READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function abortIfNeeded(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Agent run aborted.');
  error.name = 'AbortError';
  if (signal.reason !== undefined) error.cause = signal.reason;
  throw error;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function serializeToolOutput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') throw new TypeError('Tool output is not JSON-serializable.');
  return serialized;
}

function toolError(toolUse, message) {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: String(message || 'Tool call failed.'),
    is_error: true,
  };
}

function normalizePermissionInput(value) {
  if (!isRecord(value)) return { error: 'input must be a JSON object.' };
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return { error: 'input is not JSON-serializable.' };
    const normalized = JSON.parse(serialized);
    if (!isRecord(normalized)) return { error: 'input must be a JSON object.' };
    return { value: normalized };
  } catch (error) {
    return { error: 'input is not JSON-serializable: ' + errorText(error) };
  }
}

/**
 * Independent, adapter-driven Agent Loop.
 *
 * Model contract: model.stream({ messages, tools, signal, turn }) returns an
 * async iterable of text_delta, tool_use, and message_end events.
 * Tool permissions default to deny unless an explicit policy allows execution.
 * Permission policies receive phase='initial' or phase='recheck'; every changed
 * input is schema-validated and re-authorized before the tool can execute.
 */
export class AgentLoop extends EventEmitter {
  #model;
  #tools;
  #permissionPolicy;
  #approvalHandler;
  #maxTurns;
  #compactContext;
  #preToolUseHooks;
  #postToolUseHooks;
  #postToolUseFailureHooks;
  #hookMessages = [];
  #toolAttachments = [];
  #toolNativeMessages = [];
  #hookStopReason;
  #hookWorkspace;
  #toolResultStorage;
  #onSessionCheckpoint;
  #onMappedToolResult;
  #onToolExecutionStart;
  #getPendingTaskNotifications;
  #onTaskNotificationsCommitted;
  #mappedWitnessFailure;
  #requireCanUseTool;
  #permissionMode;
  #hookSessionId;
  #hookTranscriptPath;
  // Original REPL passes updatedToolUseContext and committed history into
  // each next query() invocation of the same interactive session.
  #committedSessionMessages;
  #committedToolUseContext;
  #active = false;

  constructor({
    model,
    tools = new ToolRegistry(),
    permissionPolicy = defaultDenyPermission,
    approvalHandler,
    maxTurns = 8,
    compactContext,
    preToolUseHooks = [],
    postToolUseHooks = [],
    postToolUseFailureHooks = [],
    hookWorkspace,
    toolResultStorage,
    onSessionCheckpoint,
    onMappedToolResult,
    onToolExecutionStart,
    getPendingTaskNotifications,
    onTaskNotificationsCommitted,
    requireCanUseTool = false,
    permissionMode = 'default',
    hookSessionId = '',
    hookTranscriptPath = '',
  } = {}) {
    super();
    if (!model || typeof model.stream !== 'function') {
      throw new TypeError('model must implement stream({ messages, tools, signal, turn }).');
    }
    if (!(tools instanceof ToolRegistry)) throw new TypeError('tools must be a ToolRegistry.');
    if (typeof permissionPolicy !== 'function') throw new TypeError('permissionPolicy must be a function.');
    if (approvalHandler !== undefined && typeof approvalHandler !== 'function') {
      throw new TypeError('approvalHandler must be a function when provided.');
    }
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
      throw new RangeError('maxTurns must be a positive safe integer.');
    }
    this.#model = model;
    this.#tools = tools;
    this.#permissionPolicy = permissionPolicy;
    this.#approvalHandler = approvalHandler;
    if (compactContext !== undefined && typeof compactContext !== 'function') {
      throw new TypeError('compactContext must be a function.');
    }
    if (![preToolUseHooks, postToolUseHooks, postToolUseFailureHooks].every(Array.isArray) ||
      ([preToolUseHooks, postToolUseHooks, postToolUseFailureHooks].some(hooks => hooks.length > 0) &&
       (typeof hookWorkspace !== 'string' || !hookWorkspace))) {
      throw new TypeError('Tool Hooks require validated settings and a workspace.');
    }
    if (toolResultStorage !== undefined &&
      (typeof toolResultStorage?.workspace !== 'string' ||
       typeof toolResultStorage?.directory !== 'string')) {
      throw new TypeError('toolResultStorage requires workspace and directory paths.');
    }
    this.#preToolUseHooks = preToolUseHooks;
    this.#postToolUseHooks = postToolUseHooks;
    this.#postToolUseFailureHooks = postToolUseFailureHooks;
    this.#hookWorkspace = hookWorkspace;
    this.#toolResultStorage = toolResultStorage;
    if (onSessionCheckpoint !== undefined && typeof onSessionCheckpoint !== 'function') {
      throw new TypeError('onSessionCheckpoint must be a function.');
    }
    this.#onSessionCheckpoint = onSessionCheckpoint;
    if(onMappedToolResult!==undefined && typeof onMappedToolResult!=='function') {
      throw new TypeError('onMappedToolResult must be a function.');
    }
    this.#onMappedToolResult = onMappedToolResult;
    if(onToolExecutionStart!==undefined && typeof onToolExecutionStart!=='function')
      throw new TypeError('onToolExecutionStart must be a function.');
    this.#onToolExecutionStart=onToolExecutionStart;
    if(getPendingTaskNotifications!==undefined &&
       typeof getPendingTaskNotifications!=='function')
      throw new TypeError('getPendingTaskNotifications must be a function.');
    if(onTaskNotificationsCommitted!==undefined &&
       typeof onTaskNotificationsCommitted!=='function')
      throw new TypeError('onTaskNotificationsCommitted must be a function.');
    this.#getPendingTaskNotifications=getPendingTaskNotifications;
    this.#onTaskNotificationsCommitted=onTaskNotificationsCommitted;
    // Original toolHooks.ts consumes the fork/query requireCanUseTool
    // capability flag. It defaults false for the standalone parent CLI;
    // true is explicitly supplied only by contexts requiring final review.
    if (typeof requireCanUseTool !== 'boolean') {
      throw new TypeError('requireCanUseTool must be a boolean.');
    }
    this.#requireCanUseTool = requireCanUseTool;
    // Original ToolUseContext.getAppState() exposes the active permission
    // mode to PreToolUse/PostToolUse hooks; never fabricate "default" when
    // the CLI is running in acceptEdits.
    if (!['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(permissionMode)) {
      throw new TypeError('Invalid source permission mode for Tool Hooks.');
    }
    this.#permissionMode = permissionMode;
    // Original 2.1.88 createBaseHookInput() includes the authenticated
    // session_id and the transcript path. These refer to the SAME journal
    // as the active Query, not an invented second hook transcript.
    if (typeof hookSessionId !== 'string' ||
        typeof hookTranscriptPath !== 'string' ||
        Boolean(hookSessionId) !== Boolean(hookTranscriptPath)) {
      throw new TypeError('Hook session ID and transcript path must be paired strings.');
    }
    this.#hookSessionId = hookSessionId;
    this.#hookTranscriptPath = hookTranscriptPath;
    this.#maxTurns = maxTurns;
    this.#compactContext = compactContext;
  }

  get active() {
    return this.#active;
  }

  async run({ messages = [], input, signal } = {}) {
    if (this.#active) throw new Error('This AgentLoop already has an active run.');
    // A prior write/fsync or OS descendant-tree cleanup failure is an
    // irreversible safety fence for this AgentLoop instance. A new root
    // prompt must NOT reset it and replay tools into an uncertain workspace.
    if (this.#mappedWitnessFailure) throw this.#mappedWitnessFailure;
    this.#active = true;
    // Continue a session only when the caller presents the exact last
    // committed conversation. A new root prompt or forked history cannot
    // silently reuse the previous session's permission/tool context.
    const continuesSession = messages.length > 0 &&
      Array.isArray(this.#committedSessionMessages) &&
      (messages === this.#committedSessionMessages ||
       isDeepStrictEqual(messages, this.#committedSessionMessages));
    if (!continuesSession) {
      this.#committedSessionMessages = undefined;
      this.#committedToolUseContext = undefined;
    }
    this.#hookMessages = [];
    this.#toolAttachments = [];
    this.#toolNativeMessages = [];
    this.#hookStopReason = undefined;
    try {
      const result = await query({
        messages, input, signal,
        model: this.#model,
        tools: this.#tools,
        maxTurns: this.#maxTurns,
        compactContext: this.#compactContext,
        onSessionCheckpoint: async checkpoint => {
          // A side-effecting Bash may have left an unowned Windows descendant
          // after taskkill /T failed. The 2.1.88/2.1.304 tool state cannot
          // treat a failed cleanup as a normal recoverable tool_result.
          // Keep the prior tool_pending/tool_started journal, and block
          // model continuation or any new writes until manual reconciliation.
          if(this.#mappedWitnessFailure)throw this.#mappedWitnessFailure;
          return this.#onSessionCheckpoint?.(checkpoint);
        },
        initialToolUseContext: this.#committedToolUseContext,
        getPendingTaskNotifications:this.#getPendingTaskNotifications,
        onTaskNotificationsCommitted:this.#onTaskNotificationsCommitted,
        onCommittedToolUseContext: ({ messages: checkpoint, toolUseContext }) => {
          // Original query.ts consumes newContext only for fully committed
          // tool rounds. Keep the matching history as the session resume key.
          this.#committedSessionMessages = structuredClone(checkpoint);
          this.#committedToolUseContext = toolUseContext;
        },
        canStartToolDuringStream: (toolUse, context) =>
          this.#canStartToolDuringStream(toolUse, context),
        executeTool: (toolUse, context) => this.#executeTool(toolUse, context),
        getPostToolStop: () => this.#hookStopReason,
        // Original query.ts normalizes Hook attachments after ordered
        // tool_results, not at asynchronous Hook completion time.
        getToolHookContext: ({ toolUses, turn }) =>
          normalizeToolHookAttachmentsForAPI(this.#hookMessages, toolUses, turn),
        // Same ordering boundary as original query.ts: native newMessages
        // are retained only after all authenticated sibling tool_results.
        getToolNativeMessages: ({ toolUses, turn }) => {
          const ordered = [];
          for (const toolUse of toolUses) {
            for (const event of this.#toolNativeMessages) {
              if (event.turn === turn && event.toolUseId === toolUse.id) {
                ordered.push(...structuredClone(event.blocks));
              }
            }
          }
          return ordered;
        },
        emit: (eventName, event) => {
          if (eventName === 'contextCompacted' && event?.committedMessages) {
            // Original REPL compaction is a durable conversation transition.
            // It does not reset the tool-owned context of this same session.
            this.#committedSessionMessages =
              structuredClone(event.committedMessages);
          }
          this.emit(eventName, event);
        },
      });
      // Successful model and tool turns both advance the original REPL's
      // committed continuation point; keep ToolUseContext private to Runtime.
      this.#committedSessionMessages = structuredClone(result.messages);
      if (this.#hookMessages.length) result.hookMessages = structuredClone(this.#hookMessages);
      if (this.#toolAttachments.length) result.toolAttachments = structuredClone(this.#toolAttachments);
      if (this.#toolNativeMessages.length) result.toolNativeMessages = structuredClone(this.#toolNativeMessages);
      return result;
    } catch(error) {
      // The scheduler's ordinary AbortSignal check can win the race with
      // tool execution and obscure a failed OS tree kill or journal fsync.
      // The side-effect safety fence takes precedence over cancellation:
      // callers must learn that descendants may still be alive and that
      // the source assistant/tool_started transcript needs reconciliation.
      if(this.#mappedWitnessFailure)throw this.#mappedWitnessFailure;
      throw error;
    } finally {
      this.#active = false;
    }
  }

  /**
   * Read-only speculation gate. Ported Query may start a tool as soon as its
   * tool_use block is complete, but only the trusted CLI Read/Glob/Grep tools
   * opt in. Preview global permissions without approvals or rewritten inputs;
   * the normal execution path validates and re-authorizes again.
   */
  async #canStartToolDuringStream(toolUse, { history, signal }) {
    // Only policies explicitly declaring independence from the evolving
    // assistant message may run before it is complete. Custom policies that
    // inspect message history retain the original post-message_end behavior.
    if (this.#permissionPolicy.supportsStreamingPreflight !== true) return false;
    // The original streaming executor starts Read at content_block_stop.
    // Our Node synchronous command-Hook adapter has no rollback transaction:
    // starting a PreToolUse shell command before message_end can leave side
    // effects if the model stream then fails. Keep the original executor but
    // defer tool execution until the model turn is committed whenever any
    // command Hook is explicitly configured. No-Hook early Read remains fast.
    if (this.#preToolUseHooks.length > 0 ||
        this.#postToolUseHooks.length > 0 || this.#postToolUseFailureHooks.length > 0) return false;
    const tool = this.#tools.get(toolUse.name);
    if (!tool || !EARLY_READ_TOOLS.has(toolUse.name) ||
      tool.canRunDuringStream !== true ||
      typeof tool.isConcurrencySafe !== 'function' ||
      tool.validateInput || tool.checkPermissions) return false;
    try {
      if (!tool.isConcurrencySafe(toolUse.input)) return false;
      abortIfNeeded(signal);
      const result = await this.#permissionPolicy({
        name: tool.name,
        tool: { name: tool.name, description: tool.description,
          inputSchema: structuredClone(tool.inputSchema) },
        input: structuredClone(toolUse.input),
        toolUseId: toolUse.id,
        messages: structuredClone(history),
        signal,
        phase: 'streaming-preflight',
      });
      abortIfNeeded(signal);
      return result?.behavior === 'allow' && result.updatedInput === undefined;
    } catch (error) {
      if (signal?.aborted) abortIfNeeded(signal);
      // Unknown, asking, rewritten or failing preflight is never permission
      // to speculate. The ordinary complete-turn execution path still runs.
      return false;
    }
  }

  async #executeTool(toolUse, { history, turn, signal, validatedTool, validatorContext, assistantMessage, onToolProgress, sourceToolUseContext, speculative = false }) {
    // A prior side-effecting tool may have completed while its mapped
    // recovery witness failed. Original serial executor must not start a
    // later queued tool merely because that earlier failure was converted
    // into a model-visible error result by runToolUse().
    if(this.#mappedWitnessFailure)throw this.#mappedWitnessFailure;
    const tool = this.#tools.get(toolUse.name);
    if (!tool) {
      const result = toolError(toolUse, 'Unknown tool: ' + toolUse.name);
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: toolUse.name, isError: true });
      return result;
    }
    // The schema and custom validator just ran against validatedTool in the
    // legacy execution prefix. Never substitute a different registry entry.
    if (!validatedTool || tool !== validatedTool) {
      const result = toolError(toolUse, 'Tool definition changed after input validation; refusing to execute.');
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: toolUse.name, isError: true });
      return result;
    }

    // Initial schema/value validation is now performed by the ported
    // 2.1.88 checkPermissionsAndCallTool() before permission is consulted.
    // The permission updatedInput path below must continue to revalidate.

    const requestPermissionDecision = async (
      input, phase, checkedTool = tool, checkedToolUseId = toolUse.id,
      checkedContext = sourceToolUseContext,
    ) => {
      try {
        const baseDecision = await this.#permissionPolicy({
          name: checkedTool.name,
          tool: {
            name: checkedTool.name,
            description: checkedTool.description,
            inputSchema: structuredClone(checkedTool.inputSchema),
          },
          input: structuredClone(input),
          toolUseId: checkedToolUseId,
          messages: structuredClone(history),
          signal,
          phase,
          toolUseContext: checkedContext,
        });
        abortIfNeeded(signal);
        // 2.1.88 permissions.ts asks the tool for its input-specific
        // permission decision after global rules. Deny/ask may tighten the
        // global decision; an allow cannot bypass a global ask or deny.
        // A tool-supplied updatedInput returns to the existing PR #9
        // schema-recheck + reauthorization loop before execution.
        const decision = await resolveToolSpecificPermission({
          tool: checkedTool,
          input,
          baseDecision,
          context: {
            toolUseId: checkedToolUseId,
            messages: structuredClone(history),
            signal,
            phase,
            toolUseContext: checkedContext,
          },
        });
        abortIfNeeded(signal);
        return { decision };
      } catch (error) {
        if (signal?.aborted) abortIfNeeded(signal);
        this.emit('permissionError', {
          turn, toolUseId: checkedToolUseId, toolName: checkedTool.name, error,
          nested: checkedTool !== tool,
        });
        if (checkedTool !== tool) {
          return { decision: {
            behavior: 'deny',
            reason: 'Nested permission policy failed: ' + errorText(error),
          } };
        }
        const result = toolError(toolUse, 'Permission policy failed: ' + errorText(error));
        this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true });
        return { result };
      }
    };

    const inputUpdateError = (source, message) => {
      const result = toolError(toolUse, 'Invalid tool input returned by ' + source + ': ' + message);
      this.emit('toolCallFinished', {
        turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, inputValidationFailed: true,
      });
      return { result };
    };

    // Original 2.1.88 checkPermissionsAndCallTool() keeps two inputs:
    // observable backfill for Hooks/permission and untouched callInput for
    // the final tool.call(), unless a Hook or user intentionally rewrote it.
    let { processedInput: executionInput, callInput, backfilledClone } =
      prepareObservableToolInput(tool, structuredClone(toolUse.input));
    let inputRewriteCount = 0;
    const applyUpdatedInput = async (value, source) => {
      const normalized = normalizePermissionInput(value);
      if (normalized.error) return inputUpdateError(source, normalized.error);
      if (isDeepStrictEqual(normalized.value, executionInput)) return { changed: false };

      const errors = await this.#tools.validateInput(
        toolUse.name, normalized.value, validatorContext, validatedTool,
      );
      abortIfNeeded(signal);
      if (errors.length > 0) return inputUpdateError(source, errors.join(' '));

      if (inputRewriteCount >= MAX_PERMISSION_INPUT_REWRITES) {
        const result = toolError(
          toolUse,
          'Permission checks repeatedly changed the tool input; refusing to execute.',
        );
        this.emit('toolCallFinished', {
          turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true,
        });
        return { result };
      }

      inputRewriteCount += 1;
      executionInput = normalized.value;
      return { changed: true };
    };

    // Original toolExecution.ts calls runPreToolUseHooks after input validation
    // and before resolveHookPermissionDecision. Both methods below are direct
    // transplants from 2.1.88 toolHooks.ts; the only Node adapter is the
    // explicitly configured command-hook executor / permission context.
    let hookResolvedDecision;
    let shouldPreventContinuation = false;
    let preHookStopReason;
    if (this.#preToolUseHooks.length > 0) {
      let hookPermissionResult;
      let pendingHookInput = executionInput;
      let hookStopped = false;
      const context = {
        abortController: { signal },
        workspace: this.#hookWorkspace,
        preToolUseHooks: this.#preToolUseHooks,
        sessionId: this.#hookSessionId,
        transcriptPath: this.#hookTranscriptPath,
        onProcessTreeCleanupFailure: error => {
          // Source Hook generators convert ordinary command failures into
          // messages; OS cleanup uncertainty must use the existing fatal
          // AgentLoop fence instead of being downgraded to a Hook error.
          if (error?.name === 'ProcessTreeCleanupError') {
            this.#mappedWitnessFailure = error;
          }
        },
        trustedCliDefaultPermission: this.#permissionPolicy.isBuiltinCliPolicy === true,
        requireCanUseTool: this.#requireCanUseTool,
        getAppState: () => ({ toolPermissionContext: { mode: this.#permissionMode } }),
        checkRuleBasedPermissions: async (_tool, checkedInput) => {
          const check = await requestPermissionDecision(checkedInput, 'hook-rule-check');
          if (check.result) return { behavior: 'deny', reason: 'Permission check failed.' };
          return check.decision;
        },
      };
      for await (const event of runPreToolUseHooks(
        context, tool, pendingHookInput, toolUse.id,
        assistantMessage?.id || toolUse.id, undefined, undefined, undefined
      )) {
        if (event.type === 'hookPermissionResult') {
          hookPermissionResult = event.hookPermissionResult;
        } else if (event.type === 'hookUpdatedInput') {
          pendingHookInput = event.updatedInput;
        } else if (event.type === 'message') {
          // Original 2.1.88 emits display/progress messages separately;
          // unknown internal types retain the pre-existing lifecycle event.
          this.emit('hookMessage', { turn, toolUseId: toolUse.id, message: event.message });
        } else if (event.type === 'additionalContext') {
          // Old toolExecution.ts appends this attachment to resultingMessages
          // without stopping or overriding tool permission. Query later
          // normalizes it after the complete tool_result batch.
          this.#recordPostHookMessage({
            toolUse, tool, turn, message: event.message.message,
          });
        } else if (event.type === 'preventContinuation') {
          // Original toolExecution.ts records this flag; an allowed tool
          // runs and its result is preserved *before* Query is stopped.
          shouldPreventContinuation = event.shouldPreventContinuation === true;
        } else if (event.type === 'stopReason') {
          preHookStopReason = event.stopReason;
        } else if (event.type === 'stop') {
          // Source generator's terminal stop is an abort/error path distinct
          // from JSON {continue:false}. No tool may start after it.
          hookStopped = true;
          break;
        }
      }
      if (this.#mappedWitnessFailure) throw this.#mappedWitnessFailure;
      abortIfNeeded(signal);
      if (hookStopped) {
        const result = toolError(toolUse, 'PreToolUse hook stopped tool execution.');
        this.emit('toolCallFinished', {
          turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true,
        });
        return result;
      }
      const applied = await applyUpdatedInput(pendingHookInput, 'PreToolUse hook');
      if (applied.result) return applied.result;
      // This delegates to the existing final policy/approval path. The
      // source resolver itself checks mandatory deny, ask and safety rules
      // after Hook allow; an update cannot evade schema/permission recheck.
      const canUseTool = async (_tool, proposed, _context, _assistant, _id, forceDecision) => {
        const check = await requestPermissionDecision(proposed, 'hook-permission');
        if (check.result) return { behavior: 'deny', reason: 'Permission check failed.' };
        if (forceDecision?.behavior === 'ask' && check.decision?.behavior !== 'deny') {
          return { ...forceDecision, behavior: 'ask' };
        }
        return check.decision;
      };
      const resolved = await resolveHookPermissionDecision(
        hookPermissionResult, tool, executionInput, context,
        canUseTool, assistantMessage, toolUse.id
      );
      const validated = await applyUpdatedInput(resolved.input, 'PreToolUse permission decision');
      if (validated.result) return validated.result;
      // A Hook allow is not allowed to override the current mandatory path
      // checks. The source resolveHookPermissionDecision() has already
      // performed the explicit rule/safety check using final updated input.
      hookResolvedDecision = resolved.decision;
    }

    let userModified = false;
    let approvedPermissionFeedback;
    let permissionResult = hookResolvedDecision
      ? { decision: hookResolvedDecision }
      : await requestPermissionDecision(executionInput, 'initial');
    if (permissionResult.result) return permissionResult.result;
    let decision = permissionResult.decision;

    while (true) {
      abortIfNeeded(signal);
      let behavior = decision?.behavior;
      let reason = typeof decision?.reason === 'string' ? decision.reason : '';
      if (!['allow', 'deny', 'ask'].includes(behavior)) {
        behavior = 'deny';
        reason = 'Permission policy returned an invalid decision.';
      }

      // A deny decision is terminal. An updatedInput attached to a deny result
      // must never turn that denial into an allow.
      if (behavior === 'deny') {
        const result = toolError(toolUse, 'Tool call denied: ' + (reason || 'Permission was not granted.'));
        this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true });
        return result;
      }

      if (decision.updatedInput !== undefined) {
        const applied = await applyUpdatedInput(decision.updatedInput, 'permission policy');
        if (applied.result) return applied.result;
        if (applied.changed) {
          // Re-evaluate permissions against the exact input that would execute.
          // The policy may allow the original request but deny its replacement.
          permissionResult = await requestPermissionDecision(executionInput, 'recheck');
          if (permissionResult.result) return permissionResult.result;
          decision = permissionResult.decision;
          continue;
        }
      }

      if (behavior === 'ask') {
        // A changing policy cannot start an interactive approval while the
        // model stream is incomplete. Fail closed rather than speculatively
        // asking or executing with stale preflight authorization.
        if (speculative) {
          const result = toolError(toolUse,
            'Tool call denied: streaming preflight authorization is no longer sufficient.');
          this.emit('toolCallFinished', {
            turn, toolUseId: toolUse.id, toolName: tool.name,
            isError: true, denied: true,
          });
          return result;
        }
        this.emit('permissionRequired', {
          turn,
          toolUseId: toolUse.id,
          toolName: tool.name,
          input: structuredClone(executionInput),
          reason,
        });
        if (!this.#approvalHandler) {
          const result = toolError(
            toolUse,
            'Tool call denied: ' + (reason || 'No approval handler is configured.'),
          );
          this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true });
          return result;
        }

        let approval;
        try {
          approval = await this.#approvalHandler({
            name: tool.name,
            input: structuredClone(executionInput),
            toolUseId: toolUse.id,
            reason,
            signal,
          });
          abortIfNeeded(signal);
        } catch (error) {
          if (signal?.aborted) abortIfNeeded(signal);
          const result = toolError(toolUse, 'Tool call denied: Approval handler failed: ' + errorText(error));
          this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true });
          return result;
        }

        const approved = approval === true || approval?.approved === true;
        if (!approved) {
          const denialReason = typeof approval?.reason === 'string'
            ? approval.reason
            : (reason || 'Approval was not granted.');
          const result = toolError(toolUse, 'Tool call denied: ' + denialReason);
          this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true });
          return result;
        }

        // Source PermissionAllowDecision retains feedback and pasted content
        // to append AFTER the tool_result block, never inside tool output.
        approvedPermissionFeedback = approval && typeof approval === 'object'
          ? approval : undefined;
        if (approval?.updatedInput !== undefined) {
          const applied = await applyUpdatedInput(approval.updatedInput, 'approval handler');
          if (applied.result) return applied.result;
          if (applied.changed) {
            // Original permissionDecision.userModified is passed to Tool.call
            // only for an actual user-approved input rewrite, not Hook backfill.
            userModified = true;
            // An approval for one input does not authorize a different input.
            // Re-check policy and, if needed, request approval for the replacement.
            permissionResult = await requestPermissionDecision(executionInput, 'recheck');
            if (permissionResult.result) return permissionResult.result;
            decision = permissionResult.decision;
            continue;
          }
        }

        // An approval grants the specific reviewed input, not immunity from
        // policy changes while the user was deciding. Reuse the existing
        // 2.1.88-derived global + tool-specific permission resolver after
        // approval. A new deny, rewrite, invalid decision or materially new
        // approval reason must not execute under a stale confirmation.
        const afterApproval = await requestPermissionDecision(executionInput, 'post-approval');
        if (afterApproval.result) return afterApproval.result;
        const fresh = afterApproval.decision;
        const stillAllowed = fresh?.behavior === 'allow' ||
          (fresh?.behavior === 'ask' &&
            (typeof fresh.reason === 'string' ? fresh.reason : '') === reason);
        if (!stillAllowed || fresh.updatedInput !== undefined) {
          // Keep the fresh deny reason: workspace security checks can now
          // detect a symlink installed *during* approval, and callers need
          // the exact reason rather than a generic "permission changed".
          const lateDenyReason = fresh?.behavior === 'deny' &&
            typeof fresh.reason === 'string' && fresh.reason
            ? ' ' + fresh.reason : '';
          const result = toolError(toolUse,
            'Tool call denied: permission changed during approval; review the request again.' +
              lateDenyReason);
          this.emit('toolCallFinished', {
            turn, toolUseId: toolUse.id, toolName: tool.name,
            isError: true, denied: true,
          });
          return result;
        }
        // The input and permission boundary are both still valid.
        behavior = 'allow';
      }

      if (behavior !== 'allow') {
        const result = toolError(toolUse, 'Tool call denied: ' + (reason || 'Permission was not granted.'));
        this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true });
        return result;
      }
      break;
    }

    abortIfNeeded(signal);
    let permissionContentBlocks;
    try {
      permissionContentBlocks = getOriginalPermissionContentBlocks(
        { ...decision, behavior: 'allow' }, approvedPermissionFeedback,
      );
    } catch (error) {
      const result = toolError(toolUse,
        'Invalid permission feedback: ' + errorText(error));
      this.emit('toolCallFinished', {
        turn, toolUseId: toolUse.id, toolName: tool.name,
        isError: true, denied: true,
      });
      return result;
    }
    // Original 2.1.88 Tool.call receives the same policy resolver used by
    // top-level tool authorization. Parent approval is never inherited.
    // The callee requests permission only; it owns any subsequent action.
    const canUseNestedTool = async (
      proposedTool, proposedInput, nestedContext, _assistantMessage,
      nestedId, forceDecision,
    ) => originalCanUseNestedTool({
      proposedTool, input:proposedInput, toolUseId:nestedId,
      toolUseContext:nestedContext ?? sourceToolUseContext,
      forceDecision,
      getTool:name=>this.#tools.get(name),
      validateInput:(name,input,context,expected)=>
        this.#tools.validateInput(name,input,context,expected),
      requestPermissionDecision,
      approvalHandler:this.#approvalHandler,
      signal,
      onPermissionRequired:event=>this.emit('permissionRequired',{turn,...event}),
    });
    // Source StreamingToolExecutor marks this tool 'executing' before
    // runToolUse dispatch; after final permission is granted, persist this
    // exact execution transition before Tool.call can have side effects.
    // Speculative Read is explicitly side-effect-free and may execute before
    // the assistant UUID checkpoint, so it cannot use this witness boundary.
    if(!speculative && this.#onToolExecutionStart) {
      try {
        await this.#onToolExecutionStart({
          toolUseId:toolUse.id,toolName:tool.name,
        });
      } catch(error) {
        this.#mappedWitnessFailure=error;
        throw error;
      }
    }
    this.emit('toolCallStarted', { turn, toolUseId: toolUse.id, toolName: tool.name });
    try {
      // The final input was validated and authorized before this call.
      const exactCallInput = restoreToolCallInput(
        executionInput, callInput, backfilledClone,
      );
      const result = await invokeToolCallAndMapResult(tool, exactCallInput, {
        toolUseId: toolUse.id, signal, messages: history, assistantMessage,
        onProgress: onToolProgress,
        toolResultStorage: this.#toolResultStorage,
        nativeToolUseContext: sourceToolUseContext,
        canUseNestedTool,
        userModified: userModified || decision?.userModified === true,
        // Only the real CLI's durably recorded tool_started transition
        // can assert that a fulfilled call with no usable result is unsafe
        // to replay. Standalone Runtime keeps the 2.1.88 error-result flow.
        throwOnUnfinalizedToolResult: !speculative &&
          typeof this.#onToolExecutionStart === 'function',
        onToolNewMessages: async ({sourceMessages, blocks}) => {
          const event = {
            turn, toolUseId: toolUse.id, toolName: tool.name,
            sourceMessages: structuredClone(sourceMessages),
            blocks: structuredClone(blocks),
          };
          this.#toolNativeMessages.push(event);
          this.emit('toolNewMessages', event);
        },
        onToolAttachment: async attachment => {
          // Original toolExecution.ts emits structured_output as a distinct
          // attachment; it is not an API user message or a tool_result.
          const event = { turn, toolUseId: toolUse.id, toolName: tool.name,
            attachment: structuredClone(attachment) };
          this.#toolAttachments.push(event);
          this.emit('toolAttachment', event);
        },
        // Original 2.1.88 toolExecution.ts processes/memoizes the result
        // BEFORE invoking PostToolUse. Preserve the exact raw tool data.
        onToolResult: async ({ toolOutput, mappedResult }) => {
          // Pinned 2.1.88 toolExecution.ts addToolResult() constructs a
          // mapped non-MCP result BEFORE yielding runPostToolUseHooks().
          // A command hook can outlive the CLI process; fsync a recovery
          // witness before spawning it without fabricating a model turn.
          if(this.#postToolUseHooks.length && this.#onMappedToolResult) {
            try {
              await this.#onMappedToolResult({
                toolUseId:toolUse.id, mappedResult:structuredClone(mappedResult),
              });
            } catch(error) {
              this.#mappedWitnessFailure=error;
              throw error;
            }
          }
          if (!this.#postToolUseHooks.length) return;
          await this.#emitPostToolUseHooks({
            tool, toolUse, turn, signal, executionInput, toolOutput,
          });
          if (this.#mappedWitnessFailure) throw this.#mappedWitnessFailure;
        },
      });
      abortIfNeeded(signal);
      if (shouldPreventContinuation && result.is_error !== true) {
        // Original 2.1.88 toolExecution.ts ~1572 yields this *after*
        // map/persist tool_result and PostToolUse. Query converts it into
        // a stop after its complete assistant/tool_result checkpoint.
        this.#recordPostHookMessage({
          toolUse, tool, turn,
          message: { type: 'attachment', attachment: {
            type: 'hook_stopped_continuation',
            message: preHookStopReason || 'Execution stopped by hook',
            hookName: 'PreToolUse:' + tool.name,
            toolUseID: toolUse.id, hookEvent: 'PreToolUse',
          } },
        });
      }
      this.emit('toolCallFinished', {
        turn, toolUseId: toolUse.id, toolName: tool.name, isError: result.is_error === true,
      });
      // The callback above completed result mapping/persistence and PostToolUse.
      // Carry source allow-content through the legacy stream adapter without
      // altering the actual tool_result block or its persisted contents.
      return permissionContentBlocks.length > 0
        ? { ...result, permissionContentBlocks }
        : result;
    } catch (error) {
      // Process-tree cleanup uncertainty overrides an ordinary AbortError:
      // the user's cancellation may have failed to terminate descendants,
      // so it must NOT be hidden by the source interrupt hook branch.
      // Preserve the source assistant/tool_started journal and fence model
      // continuation even when AbortSignal was set during the OS cleanup.
      if(error?.name==='ProcessTreeCleanupError' ||
          error?.name==='TaskOutputPersistenceError' ||
          error?.name==='ToolResultFinalizationError') {
        this.#mappedWitnessFailure=error;
        this.emit('toolCallFinished',{
          turn,toolUseId:toolUse.id,toolName:tool.name,
          isError:true,interrupted:signal?.aborted===true,
        });
        throw error;
      }
      // Original 2.1.88 checkPermissionsAndCallTool() catches AbortError
      // and dispatches PostToolUseFailure with isInterrupt=true BEFORE
      // returning its tool_result. The current Node Query propagates
      // cancellation to its caller, but must still execute the original
      // failure-Hook lifecycle and terminal tool status first.
      if (signal?.aborted) {
        try {
          if (this.#postToolUseFailureHooks.length) {
            await this.#emitPostToolUseFailureHooks({
              tool, toolUse, turn, signal, executionInput,
              error: errorText(error), isInterrupt: true,
            });
            if (this.#mappedWitnessFailure) throw this.#mappedWitnessFailure;
          }
        } finally {
          this.emit('toolCallFinished', {
            turn, toolUseId: toolUse.id, toolName: tool.name,
            isError: true, interrupted: true,
          });
          abortIfNeeded(signal);
        }
      }
      if (this.#postToolUseFailureHooks.length) {
        await this.#emitPostToolUseFailureHooks({
          tool, toolUse, turn, signal, executionInput,
          error: errorText(error), isInterrupt: false,
        });
        if (this.#mappedWitnessFailure) throw this.#mappedWitnessFailure;
      }
      const result = toolError(toolUse, 'Tool execution failed: ' + errorText(error));
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true });
      return result;
    }
  }
  // Keep Hook attachment updates tied to the originating tool_use, including
  // when tools finish concurrently. They are preserved in run().hookMessages
  // and delivered as EventEmitter hookMessage events; the headless Query
  // still lacks the original attachment-to-model context converter.
  #recordPostHookMessage({ toolUse, tool, turn, message }) {
    const event = {
      turn, toolUseId: toolUse.id, toolName: tool.name,
      message: structuredClone(message),
    };
    this.#hookMessages.push(event);
    if (message?.attachment?.type === 'hook_stopped_continuation') {
      this.#hookStopReason = message.attachment.message ||
        'PostToolUse Hook requested stopping the conversation.';
    }
    this.emit('hookMessage', event);
  }

  #createPostHookContext(signal) {
    return {
      abortController: { signal },
      workspace: this.#hookWorkspace,
      sessionId: this.#hookSessionId,
      transcriptPath: this.#hookTranscriptPath,
      onProcessTreeCleanupFailure: error => {
        if (error?.name === 'ProcessTreeCleanupError') {
          this.#mappedWitnessFailure = error;
        }
      },
      getAppState: () => ({ toolPermissionContext: { mode: this.#permissionMode } }),
      toolHooks: {
        PostToolUse: this.#postToolUseHooks,
        PostToolUseFailure: this.#postToolUseFailureHooks,
      },
    };
  }

  async #emitPostToolUseHooks({ tool, toolUse, turn, signal, executionInput, toolOutput }) {
    // Transplanted method body from original 2.1.88 toolHooks.ts.
    for await (const update of runPostToolUseHooks(
      this.#createPostHookContext(signal), tool, toolUse.id, toolUse.id,
      structuredClone(executionInput), toolOutput, undefined, undefined, undefined,
    )) {
      if ('updatedMCPToolOutput' in update) {
        throw new Error('MCP PostToolUse output rewriting is not supported.');
      }
      this.#recordPostHookMessage({ toolUse, tool, turn, message: update.message });
    }
  }

  async #emitPostToolUseFailureHooks({ tool, toolUse, turn, signal, executionInput, error, isInterrupt = false }) {
    // PostToolUseFailure is only called after actual tool execution fails,
    // not after a policy denial. Hook feedback never replaces the error result.
    for await (const update of runPostToolUseFailureHooks(
      this.#createPostHookContext(signal), tool, toolUse.id, toolUse.id,
      structuredClone(executionInput), error, isInterrupt, undefined, undefined, undefined,
    )) {
      this.#recordPostHookMessage({ toolUse, tool, turn, message: update.message });
    }
  }
}
