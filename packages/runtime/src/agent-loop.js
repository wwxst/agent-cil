import { EventEmitter } from 'node:events';
import { ToolRegistry } from './tool-registry.js';
import { defaultDenyPermission } from './permissions.js';

const STOP_REASONS = new Set(['end_turn', 'tool_use', 'max_tokens']);

export class ModelProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ModelProtocolError';
  }
}

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

/**
 * Independent, adapter-driven Agent Loop.
 *
 * Model contract: model.stream({ messages, tools, signal, turn }) returns an
 * async iterable of text_delta, tool_use, and message_end events.
 * Tool permissions default to deny unless an explicit policy allows execution.
 */
export class AgentLoop extends EventEmitter {
  #model;
  #tools;
  #permissionPolicy;
  #approvalHandler;
  #maxTurns;
  #active = false;

  constructor({
    model,
    tools = new ToolRegistry(),
    permissionPolicy = defaultDenyPermission,
    approvalHandler,
    maxTurns = 8,
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
    this.#maxTurns = maxTurns;
  }

  get active() {
    return this.#active;
  }

  async run({ messages = [], input, signal } = {}) {
    if (this.#active) throw new Error('This AgentLoop already has an active run.');
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
    if (messages.some(message => !isRecord(message))) throw new TypeError('Every message must be an object.');
    if (messages.length === 0 && input === undefined) {
      throw new TypeError('Provide either an initial message history or input.');
    }

    this.#active = true;
    try {
      let history = structuredClone(messages);
      if (input !== undefined) history.push({ role: 'user', content: input });
      const seenToolUseIds = new Set();
      this.emit('runStarted', { messageCount: history.length });

      for (let turn = 1; turn <= this.#maxTurns; turn += 1) {
        abortIfNeeded(signal);
        this.emit('turnStarted', { turn, messageCount: history.length });

        const content = [];
        const toolUses = [];
        let stopReason;
        let messageEnded = false;

        try {
          const stream = this.#model.stream({
            messages: structuredClone(history),
            tools: this.#tools.describe(),
            signal,
            turn,
          });
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
            throw new ModelProtocolError('model.stream() must return an async iterable.');
          }

          for await (const event of stream) {
            abortIfNeeded(signal);
            if (!isRecord(event) || typeof event.type !== 'string') {
              throw new ModelProtocolError('Model emitted a malformed stream event.');
            }
            if (messageEnded) throw new ModelProtocolError('Model emitted an event after message_end.');

            if (event.type === 'text_delta') {
              if (typeof event.text !== 'string') throw new ModelProtocolError('text_delta.text must be a string.');
              if (event.text.length === 0) continue;
              const last = content[content.length - 1];
              if (last?.type === 'text') last.text += event.text;
              else content.push({ type: 'text', text: event.text });
              this.emit('textDelta', { turn, text: event.text });
            } else if (event.type === 'tool_use') {
              if (typeof event.id !== 'string' || event.id.trim().length === 0) {
                throw new ModelProtocolError('tool_use.id must be a non-empty string.');
              }
              if (seenToolUseIds.has(event.id)) throw new ModelProtocolError('Duplicate tool_use id: ' + event.id);
              if (typeof event.name !== 'string' || event.name.trim().length === 0) {
                throw new ModelProtocolError('tool_use.name must be a non-empty string.');
              }
              if (!isRecord(event.input)) throw new ModelProtocolError('tool_use.input must be a JSON object.');
              seenToolUseIds.add(event.id);
              const toolUse = { type: 'tool_use', id: event.id, name: event.name, input: structuredClone(event.input) };
              content.push(toolUse);
              toolUses.push(toolUse);
            } else if (event.type === 'message_end') {
              const reason = event.stopReason ?? event.stop_reason;
              if (!STOP_REASONS.has(reason)) {
                throw new ModelProtocolError('message_end has an unsupported stop reason.');
              }
              stopReason = reason;
              messageEnded = true;
            } else if (event.type === 'usage') {
              this.emit('usage', { turn, usage: event.usage });
            } else {
              throw new ModelProtocolError('Unsupported model stream event: ' + event.type);
            }
          }
        } catch (error) {
          this.emit('modelError', { turn, error });
          throw error;
        }

        if (!messageEnded) throw new ModelProtocolError('Model stream ended without message_end.');
        if (toolUses.length > 0 && stopReason !== 'tool_use') {
          throw new ModelProtocolError('A message containing tool_use must end with stop_reason tool_use.');
        }
        if (toolUses.length === 0 && stopReason === 'tool_use') {
          throw new ModelProtocolError('Model ended with stop_reason tool_use but emitted no tool_use blocks.');
        }

        const assistantMessage = { role: 'assistant', content, stop_reason: stopReason };
        history.push(assistantMessage);
        this.emit('assistantMessage', { turn, message: structuredClone(assistantMessage) });

        if (toolUses.length === 0) {
          const result = { messages: history, turns: turn, stopReason, finalMessage: assistantMessage };
          this.emit('turnFinished', { turn, stopReason, toolResultCount: 0 });
          this.emit('finished', result);
          return result;
        }

        const toolResults = [];
        for (const toolUse of toolUses) {
          abortIfNeeded(signal);
          const result = await this.#executeTool(toolUse, { history, turn, signal });
          toolResults.push(result);
        }
        history.push({ role: 'user', content: toolResults });
        this.emit('turnFinished', { turn, stopReason, toolResultCount: toolResults.length });

        if (turn === this.#maxTurns) {
          const result = { messages: history, turns: turn, stopReason: 'max_turns', finalMessage: assistantMessage };
          this.emit('finished', result);
          return result;
        }
      }

      throw new Error('AgentLoop reached an unreachable state.');
    } finally {
      this.#active = false;
    }
  }

  async #executeTool(toolUse, { history, turn, signal }) {
    const tool = this.#tools.get(toolUse.name);
    if (!tool) {
      const result = toolError(toolUse, 'Unknown tool: ' + toolUse.name);
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: toolUse.name, isError: true });
      return result;
    }

    const validationErrors = await this.#tools.validateInput(toolUse.name, toolUse.input);
    if (validationErrors.length > 0) {
      const result = toolError(toolUse, 'Invalid tool input: ' + validationErrors.join(' '));
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: toolUse.name, isError: true });
      return result;
    }

    let decision;
    try {
      decision = await this.#permissionPolicy({
        name: tool.name,
        tool,
        input: structuredClone(toolUse.input),
        toolUseId: toolUse.id,
        messages: structuredClone(history),
        signal,
      });
    } catch (error) {
      this.emit('permissionError', { turn, toolUseId: toolUse.id, toolName: tool.name, error });
      const result = toolError(toolUse, 'Permission policy failed: ' + errorText(error));
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true });
      return result;
    }

    let behavior = decision?.behavior;
    let reason = typeof decision?.reason === 'string' ? decision.reason : '';
    if (!['allow', 'deny', 'ask'].includes(behavior)) {
      behavior = 'deny';
      reason = 'Permission policy returned an invalid decision.';
    }

    if (behavior === 'ask') {
      this.emit('permissionRequired', { turn, toolUseId: toolUse.id, toolName: tool.name, input: structuredClone(toolUse.input), reason });
      if (!this.#approvalHandler) {
        behavior = 'deny';
        reason = reason || 'No approval handler is configured.';
      } else {
        try {
          const approval = await this.#approvalHandler({
            name: tool.name,
            input: structuredClone(toolUse.input),
            toolUseId: toolUse.id,
            reason,
            signal,
          });
          const approved = approval === true || approval?.approved === true;
          behavior = approved ? 'allow' : 'deny';
          if (!approved) reason = typeof approval?.reason === 'string' ? approval.reason : (reason || 'Approval was not granted.');
        } catch (error) {
          behavior = 'deny';
          reason = 'Approval handler failed: ' + errorText(error);
        }
      }
    }

    if (behavior !== 'allow') {
      const result = toolError(toolUse, 'Tool call denied: ' + (reason || 'Permission was not granted.'));
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true, denied: true });
      return result;
    }

    abortIfNeeded(signal);
    this.emit('toolCallStarted', { turn, toolUseId: toolUse.id, toolName: tool.name });
    try {
      const output = await tool.execute(structuredClone(toolUse.input), {
        toolUseId: toolUse.id,
        signal,
        messages: structuredClone(history),
      });
      abortIfNeeded(signal);
      const result = { type: 'tool_result', tool_use_id: toolUse.id, content: serializeToolOutput(output) };
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: false });
      return result;
    } catch (error) {
      if (signal?.aborted) abortIfNeeded(signal);
      const result = toolError(toolUse, 'Tool execution failed: ' + errorText(error));
      this.emit('toolCallFinished', { turn, toolUseId: toolUse.id, toolName: tool.name, isError: true });
      return result;
    }
  }
}
