/**
 * Adapted executable queryLoop core from CLI 2.1.88 restored-src/src/query.ts.
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * This is the headless Node.js subset: model message streaming, tool-use
 * follow-up, ordered result history, max-turn transition, cancellation and
 * lifecycle events. Old query.ts's compaction, Hook, MCP, token budgeting,
 * sessions and fallback are not ported and MUST NOT be claimed as available.
 *
 * The existing Anthropic SSE adapter retains strict protocol validation and
 * the PR #9/#15-20 tool/permission chain remains the execution backend.
 * Unlike the previous self-built AgentLoop loop, the old query.ts explicitly
 * treats received tool_use blocks, not stop_reason, as follow-up authority.
 */
import { StreamingToolExecutor } from '../legacy-tools/streaming-tool-executor.js';
import { runToolUse } from '../legacy-tools/tool-execution.js';

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

/**
 * Replacement for the old AgentLoop.run model/tool iteration body, adapted
 * from original queryLoop's State + needsFollowUp + tool results transition.
 * emit(name, payload) preserves the existing EventEmitter surface.
 *
 * executeTool() is the already-verified permission/tool runner; this function
 * does not reimplement it or grant any extra permissions.
 */
export async function query({
  messages = [], input, signal, model, tools, maxTurns,
  executeTool, emit,
} = {}) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  if (messages.some(message => !isRecord(message))) {
    throw new TypeError('Every message must be an object.');
  }
  if (messages.length === 0 && input === undefined) {
    throw new TypeError('Provide either an initial message history or input.');
  }
  if (!model || typeof model.stream !== 'function') {
    throw new TypeError('A streaming model is required.');
  }
  if (!tools || typeof tools.describe !== 'function' || typeof tools.get !== 'function') {
    throw new TypeError('A registered tool collection is required.');
  }
  if (typeof emit !== 'function' || typeof executeTool !== 'function') {
    throw new TypeError('Query event and tool execution callbacks are required.');
  }
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new RangeError('maxTurns must be a positive safe integer.');
  }

      const initialHistory = structuredClone(messages);
      if (input !== undefined) initialHistory.push({ role: 'user', content: input });
      const seenToolUseIds = new Set();
      emit('runStarted', { messageCount: initialHistory.length });

      // Old query.ts State: mutable across model/tool iterations. Only the
      // Node CLI subset is active; compaction/Hook/session fields are gated.
      let state = { messages: initialHistory, turnCount: 1, transition: undefined };
      while (true) {
        const { messages: history, turnCount: turn } = state;
        abortIfNeeded(signal);
        emit('turnStarted', { turn, messageCount: history.length });

        const content = [];
        const toolUses = [];
        let stopReason;
        let messageEnded = false;

        try {
          const stream = model.stream({
            messages: structuredClone(history),
            tools: tools.describe(),
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
              emit('textDelta', { turn, text: event.text });
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
              emit('usage', { turn, usage: event.usage });
            } else {
              throw new ModelProtocolError('Unsupported model stream event: ' + event.type);
            }
          }
        } catch (error) {
          emit('modelError', { turn, error });
          if (signal?.aborted) abortIfNeeded(signal);
          throw error;
        }

        if (!messageEnded) throw new ModelProtocolError('Model stream ended without message_end.');
        // CLI 2.1.88 query.ts:535-539, 833-843: stop_reason === tool_use
        // is unreliable. Seeing an actual tool_use block is the sole
        // follow-up signal; do NOT drop a real tool call on end_turn, and
        // do NOT perform a tool round if there are no tool_use blocks.
        const needsFollowUp = toolUses.length > 0;

        const assistantMessage = { role: 'assistant', content, stop_reason: stopReason };
        history.push(assistantMessage);
        emit('assistantMessage', { turn, message: structuredClone(assistantMessage) });

        if (!needsFollowUp) {
          const result = {
            messages: history, turns: turn,
            stopReason: stopReason === 'tool_use' ? 'end_turn' : stopReason,
            finalMessage: assistantMessage,
          };
          emit('turnFinished', { turn, stopReason, toolResultCount: 0 });
          emit('finished', result);
          return result;
        }

        // 2.1.88 StreamingToolExecutor: queue safe tools concurrently, keep
        // Write/Edit/Bash exclusive, and preserve the existing PR #9 permission
        // chain through #executeTool as the runToolUse adapter. No tool begins
        // before message_end and protocol validation have completed.
        const executor = new StreamingToolExecutor({
          getTool: name => tools.get(name),
          signal,
          execute: (block, { signal: toolSignal }) =>
            runToolUse(
              block,
              assistantMessage,
              (toolUse, { signal: verifiedSignal, onToolProgress }) =>
                executeTool(toolUse, {
                  history, turn, signal: verifiedSignal,
                  assistantMessage, onToolProgress,
                }),
              {
                getTool: name => tools.get(name),
                signal: toolSignal,
                onInputValidationFailed: () => {
                  emit('toolCallFinished', {
                    turn, toolUseId: block.id, toolName: block.name,
                    isError: true, inputValidationFailed: true,
                  });
                },
              },
            ),
        });
        for (const toolUse of toolUses) {
          abortIfNeeded(signal);
          executor.addTool(toolUse);
        }
        const toolResults = [];
        for await (const update of executor.getRemainingResults()) {
          abortIfNeeded(signal);
          if (update.progress !== undefined) emit('toolProgress', { turn, progress: update.progress });
          if (update.message) {
            const blocks = update.message.content;
            if (!Array.isArray(blocks)) throw new ModelProtocolError('Legacy scheduler emitted an invalid tool result.');
            for (const block of blocks) {
              if (block?.type !== 'tool_result') {
                throw new ModelProtocolError('Legacy scheduler emitted an unexpected message.');
              }
              toolResults.push(block);
            }
          }
        }
        abortIfNeeded(signal);
        if (toolResults.length !== toolUses.length) {
          throw new ModelProtocolError('Legacy scheduler returned a mismatched number of tool results.');
        }
        history.push({ role: 'user', content: toolResults });
        emit('turnFinished', { turn, stopReason, toolResultCount: toolResults.length });

        if (turn === maxTurns) {
          const result = { messages: history, turns: turn, stopReason: 'max_turns', finalMessage: assistantMessage };
          emit('finished', result);
          return result;
        }

        // Original query.ts carries next iteration messages and a typed
        // continuation reason, after tool_result messages are fully batched.
        state = {
          messages: history, turnCount: turn + 1,
          transition: { reason: 'tool_use' },
        };
      }
}
