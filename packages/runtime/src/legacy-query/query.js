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
import { ModelContextLengthError } from '../anthropic-messages-adapter.js';

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
  executeTool, emit, canStartToolDuringStream, compactContext,
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
  if (canStartToolDuringStream !== undefined && typeof canStartToolDuringStream !== 'function') {
    throw new TypeError('canStartToolDuringStream must be a function.');
  }
  if (compactContext !== undefined && typeof compactContext !== 'function') {
    throw new TypeError('compactContext must be a function.');
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
      // A single error cannot recursively start an unbounded model/compact
      // retry chain. A new successful tool turn may have one fresh chance.
      let recoveredTurn = 0;
      while (true) {
        let { messages: history, turnCount: turn } = state;
        abortIfNeeded(signal);
        // Original 2.1.88 query.ts performs microcompact/autocompact before
        // each model call. Our Node subset only summarizes fully completed
        // API rounds. No tool starts until this transaction has succeeded.
        if (compactContext) {
          const before = history;
          try {
            const result = await compactContext({ messages: history, model, signal });
            abortIfNeeded(signal);
            if (!result || !Array.isArray(result.messages)) {
              throw new ModelProtocolError('Compaction returned invalid messages.');
            }
            if (result.compacted) {
              history = structuredClone(result.messages);
              state.messages = history;
              emit('contextCompacted', {
                turn, beforeCount: before.length, afterCount: history.length,
                estimatedTokens: result.estimatedTokens,
                compactedTokens: result.compactedTokens,
                // A successful compact is a committed context transition.
                committedMessages: structuredClone(history),
              });
            }
          } catch (error) {
            emit('contextCompactError', { turn, error });
            if (signal?.aborted) abortIfNeeded(signal);
            throw error;
          }
        }
        emit('turnStarted', { turn, messageCount: history.length });

        const content = [];
        const toolUses = [];
        let stopReason;
        let messageEnded = false;
        let sawStreamEvent = false;
        // Original 2.1.88 query.ts starts its StreamingToolExecutor before
        // the model response is finished. Keep this existing port and its
        // ordered queue; do not create another dispatch system.
        const assistantMessage = { role: 'assistant', content };
        const earlyIds = new Set();
        let scheduledCount = 0;
        let deferredBarrier = false;
        const executor = new StreamingToolExecutor({
          getTool: name => tools.get(name),
          signal,
          // Original StreamingToolExecutor creates unknown-tool tool_result
          // directly in addTool(), before runToolUse. Preserve the current
          // CLI lifecycle event at that source-to-Node adapter boundary.
          onUnknownTool: unknown => {
            emit('toolCallFinished', {
              turn, toolUseId: unknown.id, toolName: unknown.name, isError: true,
            });
          },
          execute: (block, { signal: toolSignal }) =>
            runToolUse(
              block,
              assistantMessage,
              (toolUse, { signal: verifiedSignal, tool: validatedTool, toolUseContext, onToolProgress }) =>
                executeTool(toolUse, {
                  history, turn, signal: verifiedSignal,
                  validatedTool, validatorContext: toolUseContext,
                  assistantMessage, onToolProgress,
                  speculative: earlyIds.has(block.id),
                }),
              {
                getTool: name => tools.get(name),
                signal: toolSignal,
                onUnknownTool: unknown => {
                  emit('toolCallFinished', {
                    turn, toolUseId: unknown.id, toolName: unknown.name, isError: true,
                  });
                },
                onInputValidationFailed: () => {
                  emit('toolCallFinished', {
                    turn, toolUseId: block.id, toolName: block.name,
                    isError: true, inputValidationFailed: true,
                  });
                },
              },
            ),
        });

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
            sawStreamEvent = true;
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
            } else if (event.type === 'thinking') {
              // 2.1.88 query.ts thinking trajectory rule: retain blocks in
              // assistant history across tool_result continuation unchanged.
              // Only text_delta is user-visible; thinking is never printed.
              if (typeof event.thinking !== 'string' ||
                (event.signature !== undefined && typeof event.signature !== 'string')) {
                throw new ModelProtocolError('Invalid protected thinking event.');
              }
              content.push({
                type: 'thinking', thinking: event.thinking,
                ...(event.signature !== undefined ? { signature: event.signature } : {}),
              });
            } else if (event.type === 'redacted_thinking') {
              if (typeof event.data !== 'string') {
                throw new ModelProtocolError('Invalid redacted_thinking event.');
              }
              content.push({ type: 'redacted_thinking', data: event.data });
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
              // Only a trusted, explicitly read-only, concurrency-safe tool
              // with a non-interactive permission preflight can start before
              // message_end. An unsafe or approval-requiring tool forms a
              // strict queue barrier for every subsequent tool in this turn.
              if (!deferredBarrier && canStartToolDuringStream) {
                const mayStart = await canStartToolDuringStream(toolUse, {
                  history, turn, signal,
                });
                abortIfNeeded(signal);
                if (mayStart) {
                  earlyIds.add(toolUse.id);
                  executor.addTool(toolUse);
                  scheduledCount++;
                } else {
                  deferredBarrier = true;
                }
              } else {
                deferredBarrier = true;
              }
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
          if (!messageEnded) {
            throw new ModelProtocolError('Model stream ended without message_end.');
          }
        } catch (error) {
          // A failed/aborted model response is not a valid assistant message.
          // Discard speculative results and abort in-flight read/search tasks.
          // No Write/Edit/Bash has been admitted before message_end.
          executor.discard();
          // Preserve the old Query observable cancellation contract: emit
          // modelError exactly once before propagating AbortError.
          if (signal?.aborted) {
            emit('modelError', { turn, error });
            abortIfNeeded(signal);
          }
          // Adapted from 2.1.88 query.ts reactive prompt-too-long branch:
          // only a typed *pre-stream* context rejection may be recovered.
          // A partial SSE response (even usage-only), tools or malformed
          // stream must NEVER be replayed, regardless of the error message.
          if (error instanceof ModelContextLengthError &&
            !sawStreamEvent && compactContext && recoveredTurn !== turn) {
            recoveredTurn = turn;
            try {
              const compacted = await compactContext({
                messages: history, model, signal, force: true,
              });
              abortIfNeeded(signal);
              if (compacted?.compacted && Array.isArray(compacted.messages)) {
                const recovered = structuredClone(compacted.messages);
                state.messages = recovered;
                emit('contextCompacted', {
                  turn, reason: 'prompt_too_long',
                  beforeCount: history.length, afterCount: recovered.length,
                  estimatedTokens: compacted.estimatedTokens,
                  compactedTokens: compacted.compactedTokens,
                  committedMessages: structuredClone(recovered),
                });
                emit('contextRetry', { turn, reason: 'prompt_too_long' });
                // This is the same model turn, not a second execution of
                // any completed tool. The only operation performed was the
                // no-tools summary request.
                continue;
              }
            } catch (compactError) {
              emit('contextCompactError', { turn, error: compactError });
              if (signal?.aborted) abortIfNeeded(signal);
            }
          }
          emit('modelError', { turn, error });
          throw error;
        }

        // CLI 2.1.88 query.ts:535-539, 833-843: stop_reason === tool_use
        // is unreliable. Seeing an actual tool_use block is the sole
        // follow-up signal; do NOT drop a real tool call on end_turn, and
        // do NOT perform a tool round if there are no tool_use blocks.
        const needsFollowUp = toolUses.length > 0;

        assistantMessage.stop_reason = stopReason;
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

        // Resume deferred tools after the complete model message has passed
        // protocol validation. Preserve model order and exclusive barriers.
        for (const toolUse of toolUses.slice(scheduledCount)) {
          abortIfNeeded(signal);
          executor.addTool(toolUse);
        }
        const toolResults = [];
        try {
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
        } catch (error) {
          executor.discard();
          throw error;
        }
        abortIfNeeded(signal);
        if (toolResults.length !== toolUses.length) {
          throw new ModelProtocolError('Legacy scheduler returned a mismatched number of tool results.');
        }
        history.push({ role: 'user', content: toolResults });
        // A complete assistant tool call and all matching tool_result blocks
        // form a resumable checkpoint. This is the headless CLI equivalent of
        // the 2.1.88 query.ts stream exposing committed messages before a
        // later API failure. Never checkpoint partial streams or tool batches.
        emit('turnFinished', {
          turn, stopReason, toolResultCount: toolResults.length,
          committedMessages: structuredClone(history),
        });

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
