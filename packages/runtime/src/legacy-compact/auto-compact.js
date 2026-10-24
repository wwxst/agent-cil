/**
 * Minimal headless Node port of CLI 2.1.88 restored-src:
 * services/compact/grouping.ts (API-round grouping);
 * services/compact/microCompact.ts:estimateMessageTokens;
 * services/compact/autoCompact.ts (threshold and failure guard);
 * services/compact/compact.ts + prompt.ts (tool-free summary and retained suffix).
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * Only complete API rounds may be removed. Never strip, change or fabricate
 * protected thinking blocks/signatures in any surviving assistant turn.
 */
import { ModelContextLengthError } from '../anthropic-messages-adapter.js';

const MIN_SUMMARY_CHARS = 12;
const MAX_SUMMARY_CHARS = 16000;
const MAX_CONSECUTIVE_FAILURES = 3;
// 2.1.88 compact.ts MAX_PTL_RETRIES means retries AFTER initial request.
const MAX_PTL_RETRIES = 3;
const RAPID_REFILL_TURN_LIMIT = 3;
const RAPID_REFILL_MAX_CONSECUTIVE = 3;

export class RapidRefillBreakerError extends Error {
  constructor() {
    super('Context repeatedly refilled in fewer than 3 tool turns after compaction; stopping this agent chain to avoid a compaction loop.');
    this.name = 'RapidRefillBreakerError';
    this.code = 'rapid_refill_breaker_tripped';
  }
}

function aborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Compaction cancelled.');
  error.name = 'AbortError';
  throw error;
}
function isRecord(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// Direct port of 2.1.88 services/api/errors.ts:
 // parsePromptTooLongTokenCounts() + getPromptTooLongTokenGap().
export function getPromptTooLongTokenGap(error) {
  const rawMessage = error?.message;
  if (!(error instanceof ModelContextLengthError) || typeof rawMessage !== 'string') {
    return undefined;
  }
  const match = rawMessage.match(/prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i);
  if (!match) return undefined;
  const actual = Number(match[1]), limit = Number(match[2]);
  const gap = actual - limit;
  return Number.isSafeInteger(gap) && gap > 0 ? gap : undefined;
}

function approximateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/**
 * From 2.1.88 microCompact.ts: estimate block payload, not signatures, and
 * pad by 4/3. Includes structural overhead for API-style messages.
 */
export function estimateMessageTokens(messages) {
  let total = 0;
  for (const message of messages) {
    if (!isRecord(message)) throw new TypeError('Invalid message in context.');
    total += 8;
    if (typeof message.content === 'string') {
      total += approximateTokens(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) throw new TypeError('Unsupported message content.');
    for (const block of message.content) {
      if (!isRecord(block)) throw new TypeError('Invalid content block.');
      if (block.type === 'text') total += approximateTokens(block.text ?? '');
      else if (block.type === 'thinking') total += approximateTokens(block.thinking ?? '');
      else if (block.type === 'redacted_thinking') total += approximateTokens(block.data ?? '');
      else if (block.type === 'tool_use') total += approximateTokens(
        String(block.name ?? '') + JSON.stringify(block.input ?? {}));
      else if (block.type === 'tool_result') total += approximateTokens(
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
      else total += approximateTokens(JSON.stringify(block));
      total += 4;
    }
  }
  return Math.ceil(total * 4 / 3);
}

/**
 * Adapted from 2.1.88 grouping.ts. This Node Query stores one assistant
 * message per API round, not a separate message for each streaming block.
 * Each group starts at a fresh assistant and includes its matching tool_result.
 */
/**
 * Port of CLI 2.1.88 utils/tokens.ts:
 * getTokenCountFromUsage() + tokenCountWithEstimation().
 * The Anthropic/DeepSeek Messages API emits cumulative snapshots. Take the
 * latest complete response, including cache input and output only ONCE, and
 * estimate only messages appended after that assistant response.
 */
export function getTokenCountFromUsage(usage) {
  // CLI 2.1.88 utils/tokens.ts requires both input_tokens and output_tokens.
  // A Messages API message_start snapshot may contain only input tokens;
  // treating the absent final output as zero corrupts the next threshold.
  if (!isRecord(usage) || !Number.isSafeInteger(usage.input_tokens) ||
    usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) ||
    usage.output_tokens < 0) return undefined;
  let total = 0;
  for (const field of ['input_tokens', 'cache_creation_input_tokens',
    'cache_read_input_tokens', 'output_tokens']) {
    const value = usage[field] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    total += value;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

export function tokenCountWithEstimation(messages) {
  // 2.1.88 utils/tokens.ts anchors on the most recent REAL response, but
  // that usage is stale immediately after a compact boundary. 2.1.304
  // excludes pre-compact response usage until a new post-compact response
  // arrives. Our synthetic summary marks how many recent original messages
  // were retained; do not mutate their signed assistant blocks or usage.
  let firstPostCompactResponse = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' &&
      Number.isSafeInteger(message.__compactRetainedMessages) &&
      message.__compactRetainedMessages >= 0) {
      firstPostCompactResponse = i + 1 + message.__compactRetainedMessages;
      break;
    }
  }
  for (let i = messages.length - 1; i >= firstPostCompactResponse; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !message.usage) continue;
    const measured = getTokenCountFromUsage(message.usage);
    if (measured !== undefined) {
      return measured + estimateMessageTokens(messages.slice(i + 1));
    }
  }
  return estimateMessageTokens(messages);
}

export function groupMessagesByApiRound(messages) {
  const groups = [];
  let current = [];
  for (const message of messages) {
    if (message.role === 'assistant' && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) groups.push(current);
  return groups;
}

function validToolPairing(messages) {
  const active = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      if (active.size) return false;
      for (const block of message.content) if (block?.type === 'tool_use') {
        if (typeof block.id !== 'string' || active.has(block.id)) return false;
        active.add(block.id);
      }
    } else if (message.role === 'user' && Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === 'tool_result') {
        if (!active.delete(block.tool_use_id)) return false;
      }
    }
  }
  return active.size === 0;
}

/** Same recent-API-round preservation as 2.1.88 summaryMessages + messagesToKeep. */
export function selectCompletedPrefix(messages, keepRecentRounds = 2) {
  if (!Array.isArray(messages) || !Number.isSafeInteger(keepRecentRounds) || keepRecentRounds < 1) {
    throw new TypeError('Invalid context or retained API-round count.');
  }
  if (!validToolPairing(messages)) return null;
  const groups = groupMessagesByApiRound(messages);
  if (groups.length <= keepRecentRounds + 1) return null;
  const cut = groups.slice(0, -keepRecentRounds).reduce((n, group) => n + group.length, 0);
  const prefix = messages.slice(0, cut);
  const recent = messages.slice(cut);
  if (!prefix.some(m => m.role === 'assistant') ||
    recent[0]?.role !== 'assistant' ||
    !validToolPairing(prefix) || !validToolPairing(recent)) return null;
  return { prefix, recent };
}

// Adapted from the 2.1.88 compact prompt / formatCompactSummary functions.
// No tools are exposed to summary sampling, and analysis is never displayed.
const SUMMARY_PROMPT = [
  'Summarize the earlier development conversation for seamless continuation.',
  'Only summarize facts and user-visible results. Do not disclose private thinking.',
  'Include: current goal, confirmed file paths, important edits, tool commands and',
  'their observed results, unresolved errors and the next intended action.',
  'Distinguish observed results from speculation. Never invent completed work.',
  'Recent unmodified API rounds will follow your summary.',
  'Return a concise plain-text summary. Do not invoke tools.',
].join('\n');

export function formatCompactSummary(summary) {
  return summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
    .replace(/<summary>([\s\S]*?)<\/summary>/g, (_, inner) => 'Summary:\n' + inner.trim())
    .replace(/\n\n+/g, '\n\n').trim();
}

/**
 * Not a second Agent Runtime. Uses the same model.stream interface, but no
 * tool schemas, tool loop, tool permissions or user-facing deltas.
 */
export function createAutoCompact({
  thresholdTokens, keepRecentRounds = 2,
  contextWindowTokens, reservedOutputTokens = 0, contextSafetyTokens = 13000,
} = {}) {
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens < 0) {
    throw new RangeError('Compact threshold must be a non-negative integer.');
  }
  // Original getAutoCompactThreshold = effective context window minus buffer;
  // 2.1.304 additionally reserves output tokens. Respect explicit low test
  // thresholds, while limiting excessively high thresholds to model capacity.
  const effectiveThreshold = Number.isSafeInteger(contextWindowTokens) &&
    contextWindowTokens > 0
    ? Math.min(thresholdTokens,
      Math.max(1, contextWindowTokens - reservedOutputTokens - contextSafetyTokens))
    : thresholdTokens;
  let consecutiveFailures = 0;
  // 2.1.304 XYo/ySr/kfo state: only rapid SUCCESSFUL compactions in the
  // same query chain count; separate user prompts start a fresh chain.
  let activeChain;
  let lastCompactTurn = null;
  let consecutiveRapidRefills = 0;
  return {
    async compact({ messages, model, signal, force = false, chainId, turn } = {}) {
      aborted(signal);
      if (chainId !== undefined && chainId !== activeChain) {
        activeChain = chainId;
        lastCompactTurn = null;
        consecutiveRapidRefills = 0;
      }
      // Disabled compaction must be a strict no-op, including for providers
      // with non-text content blocks that this first port cannot estimate.
      if (thresholdTokens === 0 || (!force && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES)) {
        return { messages, compacted: false };
      }
      // Real API usage is authoritative for the next context threshold.
      // The existing 20% *message payload* reduction guard, however, must
      // compare like with like: never compare a provider usage snapshot
      // against an unrelated local UTF-8 byte-estimated summary.
      const contextTokens = tokenCountWithEstimation(messages);
      const estimatedTokens = estimateMessageTokens(messages);
      // 2.1.88 reactive recovery bypasses proactive threshold after the
      // server itself reports that the request cannot fit. Disabling compact
      // explicitly (threshold 0) remains authoritative.
      if (!force && contextTokens < effectiveThreshold) {
        return { messages, compacted: false, estimatedTokens, contextTokens };
      }
      const selection = selectCompletedPrefix(messages, keepRecentRounds);
      if (!selection) return { messages, compacted: false, estimatedTokens };
      const { prefix, recent } = selection;
      // Preserve the newer CLI's chain-local rapid-refill breaker, distinct
      // from the older circuit breaker for three failed summary requests.
      const withinSameChain = chainId !== undefined &&
        lastCompactTurn !== null && Number.isSafeInteger(turn) &&
        turn >= lastCompactTurn && turn - lastCompactTurn < RAPID_REFILL_TURN_LIMIT;
      const nextRapidCount = withinSameChain ? consecutiveRapidRefills + 1 : 0;
      if (!force && nextRapidCount >= RAPID_REFILL_MAX_CONSECUTIVE) {
        throw new RapidRefillBreakerError();
      }
      // The original autoCompactIfNeeded returns wasCompacted:false on a
      // proactive failure rather than aborting the active Query. Before even
      // sampling, account for the mandatory new summary envelope, not just
      // protected recent rounds: otherwise the best possible replacement can
      // already exceed the 80% reduction requirement.
      const minimalReplacement = [
        { role: 'user', content:
          'This conversation continues after context compaction. Earlier completed work:\n' +
          'x'.repeat(MIN_SUMMARY_CHARS) + '\nRecent messages follow unchanged.' },
        ...recent,
      ];
      if (!force && estimateMessageTokens(minimalReplacement) >= estimatedTokens * 0.8) {
        return { messages, compacted: false, estimatedTokens };
      }
      try {
        // Port 2.1.88 compact.ts truncateHeadForPTLRetry: when the summary
        // request is also too long, discard oldest WHOLE API-round groups,
        // retain the newest one for summarizing and add a user-role marker
        // if truncation made the first request message an assistant.
        let summarize = structuredClone(prefix);
        let text = '', completed = false, stopReason;
        for (let summaryAttempt = 0; summaryAttempt <= MAX_PTL_RETRIES; summaryAttempt++) {
          text = '';
          completed = false;
          stopReason = undefined;
          let sawSummaryEvent = false;
          try {
            const stream = model.stream({
              messages: [
                ...summarize,
                { role: 'user', content: SUMMARY_PROMPT },
              ],
              tools: [], signal, purpose: 'compact',
            });
            if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
              throw new Error('Summary model did not return an event stream.');
            }
            for await (const event of stream) {
              sawSummaryEvent = true;
              aborted(signal);
              if (!isRecord(event) || typeof event.type !== 'string' || completed) {
                throw new Error('Malformed summary stream event.');
              }
              if (event.type === 'text_delta') {
                if (typeof event.text !== 'string') throw new Error('Invalid summary text.');
                text += event.text;
                if (text.length > MAX_SUMMARY_CHARS) throw new Error('Summary exceeded output bound.');
              } else if (event.type === 'message_end') {
                stopReason = event.stopReason ?? event.stop_reason;
                completed = true;
              } else if (event.type !== 'thinking' && event.type !== 'redacted_thinking' &&
                event.type !== 'usage') {
                throw new Error('Unexpected tool or protocol event during summary.');
              }
            }
            break;
          } catch (error) {
            aborted(signal);
            if (!(error instanceof ModelContextLengthError) ||
              sawSummaryEvent || summaryAttempt === MAX_PTL_RETRIES) throw error;
            // Remove our own synthetic marker before regrouping. Otherwise
            // the next overflow would drop only that marker and make no
            // forward progress (the same bug guarded by 2.1.88 compact.ts).
            const source = summarize[0]?.role === 'user' &&
              summarize[0]?.content ===
                'Older conversation rounds omitted because the summary request exceeded context.'
              ? summarize.slice(1) : summarize;
            const groups = groupMessagesByApiRound(source);
            if (groups.length < 2) throw error;
            // 2.1.88 truncateHeadForPTLRetry: remove whole API rounds
            // until the *reported excess* tokens are covered. When provider
            // omits this detail, fall back to 20% of the groups.
            const gap = getPromptTooLongTokenGap(error);
            let removed = 0;
            if (gap !== undefined) {
              let freed = 0;
              for (const group of groups) {
                freed += estimateMessageTokens(group);
                removed++;
                if (freed >= gap) break;
              }
            } else {
              removed = Math.max(1, Math.floor(groups.length * 0.2));
            }
            removed = Math.min(removed, groups.length - 1);
            summarize = groups.slice(removed).flat();
            if (!validToolPairing(summarize)) throw error;
            if (summarize[0]?.role === 'assistant') {
              summarize.unshift({ role: 'user', content:
                'Older conversation rounds omitted because the summary request exceeded context.' });
            }
          }
        }
        aborted(signal);
        const summary = formatCompactSummary(text);
        if (!completed || stopReason !== 'end_turn' || summary.length < MIN_SUMMARY_CHARS) {
          throw new Error('Summary incomplete or empty.');
        }
        const next = [
          { role: 'user', content:
            'This conversation continues after context compaction. Earlier completed work:\n' +
            summary + '\nRecent messages follow unchanged.',
            // Metadata is intentionally not serialized to DeepSeek. It
            // invalidates pre-compact usage without changing recent blocks.
            __compactRetainedMessages: recent.length },
          ...structuredClone(recent).map(message => {
            // Precompact response usage describes the OLD context size. Keep
            // all protected content/signatures byte-for-byte but clear only
            // stale accounting metadata; the next completed response will
            // establish a fresh authoritative usage anchor.
            if (message.usage) delete message.usage;
            return message;
          }),
        ];
        const nextTokens = estimateMessageTokens(next);
        if (nextTokens >= estimatedTokens * 0.8) {
          throw new Error('Summary did not sufficiently reduce context size.');
        }
        consecutiveFailures = 0;
        if (chainId !== undefined && Number.isSafeInteger(turn)) {
          lastCompactTurn = turn;
          consecutiveRapidRefills = nextRapidCount;
        }
        return {
          messages: next, compacted: true,
          estimatedTokens, contextTokens, compactedTokens: nextTokens,
          removedMessages: prefix.length,
        };
      } catch (error) {
        if (signal?.aborted) aborted(signal);
        consecutiveFailures++;
        // Port of 2.1.88 autoCompactIfNeeded's catch branch: normal
        // compaction failures do NOT abort a healthy development task.
        // Circuit-break after 3 consecutive failures, and never commit a
        // partial summary. Forced prompt-too-long recovery still throws the
        // real failure rather than hiding an already-rejected model request.
        if (!force) {
          return { messages, compacted: false, estimatedTokens,
            error, consecutiveFailures };
        }
        throw error;
      }
    },
    get consecutiveFailures() { return consecutiveFailures; },
  };
}
