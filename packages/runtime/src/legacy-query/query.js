/**
 * Adapted executable queryLoop core from CLI 2.1.88 restored-src/src/query.ts.
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * This is the headless Node.js dependency closure: model streaming, ordered
 * tool execution, durable checkpoints, output-limit recovery and tool-free
 * auto-compaction. The 2.1.88 aggregate tool-result budget is opt-in because
 * its original GrowthBook gate is not available in this local CLI. Full
 * microcompact, context-collapse, MCP and original Hook orchestration remain
 * outside this Node-only path.
 *
 * The existing Anthropic SSE adapter retains strict protocol validation and
 * the PR #9/#15-20 tool/permission chain remains the execution backend.
 * Unlike the previous self-built AgentLoop loop, the old query.ts explicitly
 * treats received tool_use blocks, not stop_reason, as follow-up authority.
 */
import { randomUUID } from 'node:crypto';
import { StreamingToolExecutor } from '../legacy-tools/streaming-tool-executor.js';
import { hasCompleteApiUsage } from '../legacy-compact/legacy-token-adapter.js';
import { runToolUse } from '../legacy-tools/tool-execution.js';
import { ModelContextLengthError } from '../anthropic-messages-adapter.js';
import { normalizeMessagesForAPI } from './normalize-messages-for-api.js';
import { applyToolResultBudget } from '../legacy-tools/tool-result-storage.js';

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
  executeTool, emit, canStartToolDuringStream, compactContext, getPostToolStop,
  getToolHookContext, getToolNativeMessages,
  getPendingTaskNotifications, onTaskNotificationsCommitted,
  initialToolUseContext, onCommittedToolUseContext, onSessionCheckpoint,
  contentReplacementState, toolResultStorage, toolResultBudgetLimit = 200_000,
  onContentReplacement,
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
  if (getToolHookContext !== undefined && typeof getToolHookContext !== 'function') {
    throw new TypeError('getToolHookContext must be a function.');
  }
  if (getToolNativeMessages !== undefined && typeof getToolNativeMessages !== 'function') {
    throw new TypeError('getToolNativeMessages must be a function.');
  }
  if (getPendingTaskNotifications !== undefined &&
      typeof getPendingTaskNotifications !== 'function')
    throw new TypeError('getPendingTaskNotifications must be a function.');
  if (onTaskNotificationsCommitted !== undefined &&
      typeof onTaskNotificationsCommitted !== 'function')
    throw new TypeError('onTaskNotificationsCommitted must be a function.');
  if (getPostToolStop !== undefined && typeof getPostToolStop !== 'function') {
    throw new TypeError('getPostToolStop must be a function.');
  }
  if (onSessionCheckpoint !== undefined && typeof onSessionCheckpoint !== 'function') {
    throw new TypeError('onSessionCheckpoint must be a function.');
  }
  if (onCommittedToolUseContext !== undefined &&
      typeof onCommittedToolUseContext !== 'function') {
    throw new TypeError('onCommittedToolUseContext must be a function.');
  }
  if (onContentReplacement !== undefined && typeof onContentReplacement !== 'function') {
    throw new TypeError('onContentReplacement must be a function.');
  }
  if (contentReplacementState !== undefined &&
      (!contentReplacementState || !(contentReplacementState.seenIds instanceof Set) ||
       !(contentReplacementState.replacements instanceof Map))) {
    throw new TypeError('contentReplacementState must be a provisioned source decision state.');
  }
  if (contentReplacementState && typeof tools.list !== 'function') {
    throw new TypeError('Aggregate tool-result budgeting requires a registry list() method.');
  }
  if (!Number.isSafeInteger(toolResultBudgetLimit) || toolResultBudgetLimit < 1) {
    throw new RangeError('toolResultBudgetLimit must be a positive safe integer.');
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
      // Ported from 2.1.88 query.ts / 2.1.304 output-limit recovery:
      // a complete max_tokens response may continue with a bounded meta
      // prompt. This is a new model request, never a replay of tool effects.
      let outputLimitRecoveryCount = 0;
      // Original query.ts ~1402 propagates update.newContext back into the
      // next query iteration. The source tool scheduler already owns the
      // modifier; retain its resulting state across model rounds rather than
      // reinitializing an empty ToolUseContext for every assistant turn.
      let sourceToolUseContext = initialToolUseContext;
      while (true) {
        let { messages: history, turnCount: turn } = state;
        abortIfNeeded(signal);
        // Original enqueuePendingNotification(mode:'task-notification') is
        // drained into the NEXT provider request, never injected into an
        // already-running SSE response. Commit the genuine native message
        // before telling LocalShellTask it has been delivered: a later
        // model transport failure must not lose the completed task notice.
        if (getPendingTaskNotifications) {
          const pending=await getPendingTaskNotifications();
          abortIfNeeded(signal);
          if(!Array.isArray(pending) || pending.some(item=>
            !item || typeof item.taskId!=='string' ||
            typeof item.text!=='string' ||
            !item.text.startsWith('<task_notification>\n'))) {
            throw new ModelProtocolError('LocalShellTask returned malformed notifications.');
          }
          if(pending.length) {
            const notification={
              role:'user',content:pending.map(item=>({type:'text',text:item.text})),
            };
            const nextHistory=[...history,notification];
            await onSessionCheckpoint?.({
              messages:structuredClone(nextHistory),kind:'task_notification',
            });
            // Once fsync succeeds, acknowledge this EXACT notification
            // before inspecting a racing AbortSignal. Otherwise the
            // in-memory task queue could deliver the already committed
            // notice a second time during the next interactive prompt.
            history=nextHistory;
            state.messages=history;
            await onTaskNotificationsCommitted?.(pending.map(item=>item.taskId));
            abortIfNeeded(signal);
          }
        }
        // Original query.ts applies aggregate tool-result replacement before
        // microcompact/autocompact. Keep the full transcript in history; only
        // the provider projection receives previews until a real compact root
        // commits that new context. The journal records decisions before any
        // subsequent provider request.
        let requestHistory = history;
        if (contentReplacementState) {
          try {
            const budgeted = await applyToolResultBudget(
              history, contentReplacementState, toolResultStorage, {
                limit: toolResultBudgetLimit,
                skipToolNames: new Set(tools.list()
                  .filter(tool => !Number.isFinite(tool.maxResultSizeChars) ||
                    tool.skipAggregateToolResultBudget === true)
                  .flatMap(tool => [tool.name, ...(tool.aliases ?? [])])),
              },
            );
            requestHistory = budgeted.messages;
            if (budgeted.newlyReplaced.length) {
              await onContentReplacement?.(budgeted.newlyReplaced);
            }
          } catch (error) {
            emit('toolResultBudgetError', { turn, error });
            throw error;
          }
        }

        // The source performs microcompact before auto-compact. This Node
        // dependency closure retains the tool-free auto-compact stage.
        if (compactContext) {
          const before = requestHistory;
          try {
            const result = await compactContext({ messages: requestHistory, model, signal });
            abortIfNeeded(signal);
            if (!result || !Array.isArray(result.messages)) {
              throw new ModelProtocolError('Compaction returned invalid messages.');
            }
            if (result.compacted) {
              history = structuredClone(result.messages);
              requestHistory = history;
              state.messages = history;
              // Old Session persists a completed context transition before
              // another model request. A failed disk write stops the query.
              await onSessionCheckpoint?.({ messages: structuredClone(history), kind: 'compact' });
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
        let lastUsage;
        let messageEnded = false;
        let sawStreamEvent = false;
        // Original 2.1.88 query.ts starts its StreamingToolExecutor before
        // the model response is finished. Keep this existing port and its
        // ordered queue; do not create another dispatch system.
        // The original transcript carries the provider assistant message ID.
        // The Node adapter exposes block events only, so mint a stable
        // per-response ID for source-compatible grouping and API normalization.
        const assistantMessage = { sourceMessageId: randomUUID(), role: 'assistant', content };
        const earlyIds = new Set();
        let scheduledCount = 0;
        let deferredBarrier = false;
        const executor = new StreamingToolExecutor({
          initialContext: sourceToolUseContext,
          getTool: name => tools.get(name),
          signal,
          // Original executor handles unknown tools before runToolUse dispatch.
          onUnknownTool: unknown => {
            emit('toolCallFinished', {
              turn, toolUseId: unknown.id, toolName: unknown.name, isError: true,
            });
          },
          execute: (block, { signal: toolSignal, toolUseContext: sourceToolUseContext }) =>
            runToolUse(
              block,
              assistantMessage,
              (toolUse, { signal: verifiedSignal, tool: validatedTool, toolUseContext, onToolProgress }) =>
                executeTool(toolUse, {
                  history: requestHistory, turn, signal: verifiedSignal,
                  validatedTool, validatorContext: toolUseContext,
                  assistantMessage, onToolProgress,
                  sourceToolUseContext,
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
            messages: normalizeMessagesForAPI(requestHistory),
            tools: tools.describe(),
            signal,
            turn,
          });
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
            throw new ModelProtocolError('model.stream() must return an async iterable.');
          }

          const streamIterator = stream[Symbol.asyncIterator]();
          let streamDone = false;
          let streamNext = streamIterator.next()
            .then(result => ({ kind: 'stream', result }));
          let drainGeneration = executor.drainGeneration;
          let drainNext = executor.waitForDrainable(drainGeneration)
            .then(generation => ({ kind: 'drain', generation }));
          try {
            while (true) {
              const next = await Promise.race([streamNext, drainNext]);
              if (next.kind === 'drain') {
                drainGeneration = next.generation;
                for (const update of executor.getPendingProgress()) {
                  if (update.progress !== undefined) {
                    emit('toolProgress', { turn, progress: update.progress });
                  }
                }
                drainNext = executor.waitForDrainable(drainGeneration)
                  .then(generation => ({ kind: 'drain', generation }));
                continue;
              }
              if (next.result.done) {
                streamDone = true;
                break;
              }
              const event = next.result.value;
              sawStreamEvent = true;
              abortIfNeeded(signal);
            if (!isRecord(event) || typeof event.type !== 'string') {
              throw new ModelProtocolError('Model emitted a malformed stream event.');
            }
            if (messageEnded) throw new ModelProtocolError('Model emitted an event after message_end.');

            if (event.type === 'text_delta') {
              if (typeof event.text !== 'string') throw new ModelProtocolError('text_delta.text must be a string.');
              if (event.text.length === 0) {
                streamNext = streamIterator.next()
                  .then(result => ({ kind: 'stream', result }));
                continue;
              }
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
                  history: requestHistory, turn, signal,
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
              if (event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage)) {
                // The SSE adapter emits evolving snapshots. Keep only the
                // last complete response snapshot; never add deltas together.
                lastUsage = structuredClone(event.usage);
              }
              emit('usage', { turn, usage: event.usage });
              } else {
                throw new ModelProtocolError('Unsupported model stream event: ' + event.type);
              }
              // Do not request the next provider event until this event has
              // been fully validated. If it fails, iterator cleanup has no
              // outstanding next() call to wait behind.
              streamNext = streamIterator.next()
                .then(result => ({ kind: 'stream', result }));
            }
          } finally {
            executor.cancelDrainWait();
            if (!streamDone && typeof streamIterator.return === 'function') {
              try { await streamIterator.return(); } catch {}
            }
          }
          // Catch a final progress item whose wake raced with stream completion.
          // Tool results remain in the original scheduler for the post-message
          // checkpoint/drain path below.
          for (const update of executor.getPendingProgress()) {
            if (update.progress !== undefined) {
              emit('toolProgress', { turn, progress: update.progress });
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
          // Discard prevents new speculative tools and aborts their signal,
          // but original running generators still own real file handles.
          // Do not report the model failure until those already-started
          // tools have finished their abort/close cleanup.
          await executor.awaitInFlightCleanup();
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
                messages: requestHistory, model, signal, force: true,
              });
              abortIfNeeded(signal);
              if (compacted?.compacted && Array.isArray(compacted.messages)) {
                const recovered = structuredClone(compacted.messages);
                await onSessionCheckpoint?.({ messages: structuredClone(recovered), kind: 'compact' });
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
        if (hasCompleteApiUsage(lastUsage)) {
          assistantMessage.usage = lastUsage;
        }
        // Source query.ts does not persist an empty assistant message when
        // the provider returns max_tokens before producing any content. The
        // API adapter represents that source synthetic error as message_end.
        const emptyOutputLimitResponse =
          stopReason === 'max_tokens' && assistantMessage.content.length === 0;
        if (!emptyOutputLimitResponse) {
          history.push(assistantMessage);
          emit('assistantMessage', { turn, message: structuredClone(assistantMessage) });
        }

        if (needsFollowUp) {
          // Original 2.1.88 Query yields its complete assistant tool_use
          // message before tool_result; insertMessageChain persists that
          // assistant UUID independently. Do this before admitting deferred
          // side-effecting tools so a crash cannot silently replay them.
          try {
            await onSessionCheckpoint?.({
              messages:structuredClone(history),kind:'tool_pending',
            });
          } catch(error) {
            executor.discard();
            await executor.awaitInFlightCleanup();
            throw error;
          }
        }
        if (!needsFollowUp) {
          // The source API adapter emits a synthetic max_output_tokens
          // error after the partial assistant message. This Node adapter
          // represents the same condition as message_end(max_tokens), so
          // persist the partial response plus the exact source recovery
          // instruction before issuing another provider request.
          if (stopReason === 'max_tokens' &&
              outputLimitRecoveryCount < 3) {
            outputLimitRecoveryCount++;
            history.push({
              role: 'user',
              isMeta: true,
              content: "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.",
            });
            await onSessionCheckpoint?.({
              messages: structuredClone(history), kind: 'output_recovery',
            });
            emit('outputLimitRecovery', {
              turn, attempt: outputLimitRecoveryCount,
            });
            state = {
              messages: history,
              turnCount: turn,
              transition: {
                reason: 'max_output_tokens_recovery',
                attempt: outputLimitRecoveryCount,
              },
            };
            continue;
          }
          if (stopReason === 'max_tokens') {
            // Match the source synthetic API-error tail. Retain it in the
            // durable transcript so exhausted recovery is not mistaken for
            // pending user input; the API projection filters it on later turns.
            history.push({
              role: 'assistant',
              isApiErrorMessage: true,
              apiError: 'max_output_tokens',
              content: [{
                type: 'text',
                text: 'API Error: The model reached the output token limit before completing the response.',
              }],
            });
          }
          const result = {
            messages: history, turns: turn,
            stopReason: stopReason === 'tool_use' ? 'end_turn' : stopReason,
            finalMessage: assistantMessage,
          };
          // Fully completed text turns also advance the resumable transcript.
          // Incomplete SSE text never reaches this commit boundary.
          await onSessionCheckpoint?.({ messages: structuredClone(history), kind: 'finished' });
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
        let finalToolBlocks;
        try {
          for await (const update of executor.getRemainingResults()) {
            abortIfNeeded(signal);
            if (update.progress !== undefined) emit('toolProgress', { turn, progress: update.progress });
            if (update.message) {
              const blocks = update.message.content;
              if (!Array.isArray(blocks)) throw new ModelProtocolError('Legacy scheduler emitted an invalid tool result.');
              // Original toolExecution.ts adds permission acceptFeedback and
              // contentBlocks to the same user message after its tool_result.
              // Keep tool IDs authenticated and keep all result blocks
              // together before ancillary user content for Anthropic/OpenAI.
              let sawToolResult = false;
              const completeBlocks = [];
              for (const block of blocks) {
                if (block?.type === 'tool_result') {
                  if (sawToolResult) throw new ModelProtocolError(
                    'Tool execution emitted multiple results for one tool_use.');
                  sawToolResult = true;
                  const expected=toolUses[toolResults.length];
                  if(!expected || block.tool_use_id!==expected.id) {
                    throw new ModelProtocolError('Tool result does not match the ordered assistant tool_use.');
                  }
                  toolResults.push(block);
                } else if ((block?.type === 'text' && typeof block.text === 'string') ||
                           (block?.type === 'image' && block.source?.type === 'base64')) {
                  if (!sawToolResult) throw new ModelProtocolError(
                    'Permission content must follow its tool_result.');
                } else {
                  throw new ModelProtocolError('Legacy scheduler emitted an unexpected message.');
                }
                completeBlocks.push(block);
              }
              if(!sawToolResult)throw new ModelProtocolError('Tool update has no tool_result.');
              if(toolResults.length<toolUses.length) {
                // Original 2.1.88 Query yields each complete tool_result;
                // sessionStorage.insertMessageChain() enqueues it before
                // waiting for the next sibling. Never lose a successful
                // Write/Bash result because a later tool hangs or aborts.
                history.push({role:'user',content:structuredClone(completeBlocks)});
                await onSessionCheckpoint?.({
                  messages:structuredClone(history),kind:'tool_partial',
                });
              } else {
                // Wait until original Hook/native attachment normalization
                // finishes before closing the last tool user message.
                finalToolBlocks=completeBlocks;
              }
            }
          }
        } catch (error) {
          executor.discard();
          await executor.awaitInFlightCleanup();
          throw error;
        }
        abortIfNeeded(signal);
        if (toolResults.length !== toolUses.length) {
          throw new ModelProtocolError('Legacy scheduler returned a mismatched number of tool results.');
        }
        // Original query.ts consumes update.newContext after tool execution,
        // not at the start of the next model stream. Do this only after the
        // entire authenticated tool batch is complete; aborted or discarded
        // rounds cannot commit a partial tool-owned context transition.
        sourceToolUseContext = executor.getUpdatedContext();
        // 2.1.88 query.ts: after toolUpdates have all finished, normalize
        // Hook attachments for API and merge with the tool-result user turn.
        // Never interleave user messages with a partially collected batch.
        // The source-normalized transport merges adjacent tool_result user
        // messages and moves results before ancillary text/image blocks.
        if(!finalToolBlocks) {
          throw new ModelProtocolError('Legacy scheduler omitted its final tool result.');
        }
        let hookContext, nativeNewBlocks;
        try {
          hookContext = getToolHookContext
            ? await getToolHookContext({ toolUses, turn, signal })
            : [];
          abortIfNeeded(signal);
          if (!Array.isArray(hookContext) ||
              hookContext.some(block =>
                !block || block.type !== 'text' || typeof block.text !== 'string')) {
            throw new ModelProtocolError('Original Hook normalization returned invalid API blocks.');
          }
          // Old 2.1.88 checkPermissionsAndCallTool() emits tool_result before
          // the following Hook / native newMessages. The normal success path
          // retains the original API projection and attachment order.
          nativeNewBlocks = getToolNativeMessages
            ? await getToolNativeMessages({ toolUses, turn, signal }) : [];
          abortIfNeeded(signal);
          if (!Array.isArray(nativeNewBlocks) || nativeNewBlocks.some(b =>
            !b || !(b.type === 'text' && typeof b.text === 'string') &&
            !(b.type === 'image' && b.source?.type === 'base64'))) {
            throw new ModelProtocolError('Original tool newMessages normalization returned invalid API blocks.');
          }
        } catch(error) {
          // Result mapping and original PostToolUse execution have already
          // completed at this point. A failed AFTER-TOOL attachment
          // normalization must not erase the final result of a Write/Bash.
          // Preserve the fully paired result using the ordinary incremental
          // source UUID chain. The tool_uncertain fence deliberately blocks
          // automatic resume: failed Hook/native context must be reviewed,
          // not silently dropped from a live model continuation.
          history.push({role:'user',content:structuredClone(finalToolBlocks)});
          await onSessionCheckpoint?.({
            messages:structuredClone(history),kind:'tool_uncertain',
          });
          throw error;
        }
        history.push({role:'user',content:[
          ...finalToolBlocks,...hookContext,...nativeNewBlocks,
        ]});
        // A complete assistant tool call and all matching tool_result blocks
        // form a resumable checkpoint. This is the headless CLI equivalent of
        // the 2.1.88 query.ts stream exposing committed messages before a
        // later API failure. Never checkpoint partial streams or tool batches.
        // Durable tool result checkpoint must finish BEFORE the next model
        // request. This prevents replaying a completed Write/Bash on a later
        // model transport failure or process restart.
        await onSessionCheckpoint?.({ messages: structuredClone(history), kind: 'tool' });
        emit('turnFinished', {
          turn, stopReason, toolResultCount: toolResults.length,
          committedMessages: structuredClone(history),
        });
        // The original REPL owns ToolUseContext across calls to query().
        // This callback belongs to the same completed tool transaction;
        // never transfer state from a partial/failed tool batch.
        onCommittedToolUseContext?.({
          messages: history,
          toolUseContext: sourceToolUseContext,
          turn,
        });

        // The original PostToolUse generator emits hook_stopped_continuation
        // when JSON {continue:false} is returned. The Node headless Query
        // must honor it after the completed tool_result checkpoint, rather
        // than accidentally requesting another model round.
        const postToolStop = getPostToolStop?.();
        if (typeof postToolStop === 'string' && postToolStop) {
          const result = {
            messages: history, turns: turn, stopReason: 'hook_stopped',
            stopMessage: postToolStop, finalMessage: assistantMessage,
          };
          emit('hookStopped', { turn, reason: postToolStop });
          emit('finished', result);
          return result;
        }
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
