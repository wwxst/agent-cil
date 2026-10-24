import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { ToolRegistry } from './tool-registry.js';
import { defaultDenyPermission } from './permissions.js';
import { invokeToolCallAndMapResult } from './legacy-tools/tool-execution.js';
import { runPreToolUseHooks, resolveHookPermissionDecision } from './legacy-tools/pretooluse-core.js';
import { query } from './legacy-query/query.js';
export { ModelProtocolError } from './legacy-query/query.js';
import { resolveToolSpecificPermission } from './legacy-permissions/tool-specific-permission.js';

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
  #hookWorkspace;
  #active = false;

  constructor({
    model,
    tools = new ToolRegistry(),
    permissionPolicy = defaultDenyPermission,
    approvalHandler,
    maxTurns = 8,
    compactContext,
    preToolUseHooks = [],
    hookWorkspace,
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
    if (!Array.isArray(preToolUseHooks) ||
      (preToolUseHooks.length > 0 && (typeof hookWorkspace !== 'string' || !hookWorkspace))) {
      throw new TypeError('PreToolUse hooks require validated settings and a workspace.');
    }
    this.#preToolUseHooks = preToolUseHooks;
    this.#hookWorkspace = hookWorkspace;
    this.#maxTurns = maxTurns;
    this.#compactContext = compactContext;
  }

  get active() {
    return this.#active;
  }

  async run({ messages = [], input, signal } = {}) {
    if (this.#active) throw new Error('This AgentLoop already has an active run.');
    this.#active = true;
    try {
      return await query({
        messages, input, signal,
        model: this.#model,
        tools: this.#tools,
        maxTurns: this.#maxTurns,
        compactContext: this.#compactContext,
        canStartToolDuringStream: (toolUse, context) =>
          this.#canStartToolDuringStream(toolUse, context),
        executeTool: (toolUse, context) => this.#executeTool(toolUse, context),
        emit: (eventName, event) => this.emit(eventName, event),
      });
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

  async #executeTool(toolUse, { history, turn, signal, validatedTool, validatorContext, assistantMessage, onToolProgress, speculative = false }) {
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

    const requestPermissionDecision = async (input, phase) => {
      try {
        const baseDecision = await this.#permissionPolicy({
          name: tool.name,
          tool: {
            name: tool.name,
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
          },
          input: structuredClone(input),
          toolUseId: toolUse.id,
          messages: structuredClone(history),
          signal,
          phase,
        });
        abortIfNeeded(signal);
        // 2.1.88 permissions.ts asks the tool for its input-specific
        // permission decision after global rules. Deny/ask may tighten the
        // global decision; an allow cannot bypass a global ask or deny.
        // A tool-supplied updatedInput returns to the existing PR #9
        // schema-recheck + reauthorization loop before execution.
        const decision = await resolveToolSpecificPermission({
          tool,
          input,
          baseDecision,
          context: {
            toolUseId: toolUse.id,
            messages: structuredClone(history),
            signal,
            phase,
          },
        });
        abortIfNeeded(signal);
        return { decision };
      } catch (error) {
        if (signal?.aborted) abortIfNeeded(signal);
        this.emit('permissionError', { turn, toolUseId: toolUse.id, toolName: tool.name, error });
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

    let executionInput = structuredClone(toolUse.input);
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
    if (this.#preToolUseHooks.length > 0) {
      let hookPermissionResult;
      let pendingHookInput = executionInput;
      let hookStopped = false;
      const context = {
        abortController: { signal },
        workspace: this.#hookWorkspace,
        preToolUseHooks: this.#preToolUseHooks,
        trustedCliDefaultPermission: this.#permissionPolicy.isBuiltinCliPolicy === true,
        getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
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
          this.emit('hookMessage', { turn, toolUseId: toolUse.id, message: event.message });
        } else if (event.type === 'additionalContext' ||
                   event.type === 'preventContinuation' || event.type === 'stop') {
          // The Node Query does not yet support arbitrary Hook attachment
          // persistence / stopping its outer generator. Never ignore an
          // unsupported side effect and then continue executing the tool.
          hookStopped = true;
          break;
        }
      }
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

        if (approval?.updatedInput !== undefined) {
          const applied = await applyUpdatedInput(approval.updatedInput, 'approval handler');
          if (applied.result) return applied.result;
          if (applied.changed) {
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
    this.emit('toolCallStarted', { turn, toolUseId: toolUse.id, toolName: tool.name });
    try {
      // The final input was validated and authorized before this call.
      const result = await invokeToolCallAndMapResult(tool, executionInput, {
        toolUseId: toolUse.id, signal, messages: history, assistantMessage,
        onProgress: onToolProgress,
      });
      abortIfNeeded(signal);
      this.emit('toolCallFinished', {
        turn, toolUseId: toolUse.id, toolName: tool.name, isError: result.is_error === true,
      });
      return result;
    } catch (error) {
      if (signal?.aborted) abortIfNeeded(signal);
      const result = toolError(toolUse, 'Tool execution failed: ' + errorText(error));
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true });
      return result;
    }
  }
}
