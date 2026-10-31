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
import { normalizeMessagesForAPI } from '../legacy-query/normalize-messages-for-api.js';
import { tokenCountForCliMessages,
  estimateFreshCompactedCliMessages } from './legacy-token-adapter.js';

const MIN_SUMMARY_CHARS = 12;
const MAX_SUMMARY_CHARS = 16000;
const MAX_CONSECUTIVE_FAILURES = 3;

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

/** Canonical 2.1.88 tokens.ts tokenCountWithEstimation path.
 * Full API usage anchors the last response; only suffix messages use rough
 * estimation. Never sum per-SSE usage snapshots or infer missing output. */
export function estimateMessageTokens(messages) {
  return tokenCountForCliMessages(messages);
}

/**
 * Direct role-based port of 2.1.88 services/compact/grouping.ts. A boundary
 * starts only when a genuinely new assistant message ID appears; streaming
 * fragments with the same sourceMessageId stay in one API round.
 */
export function groupMessagesByApiRound(messages) {
  const groups = [];
  let current = [];
  let lastAssistantId;
  for (const message of messages) {
    const assistantId = message?.role === 'assistant'
      ? (message.sourceMessageId ?? message.id ?? message) : undefined;
    if (message?.role === 'assistant' &&
        assistantId !== lastAssistantId && current.length > 0) {
      groups.push(current);
      current = [message];
    } else {
      current.push(message);
    }
    if (message?.role === 'assistant') lastAssistantId = assistantId;
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
export function createAutoCompact({ thresholdTokens, keepRecentRounds = 2 } = {}) {
  // Source shouldAutoCompact() resolves getAutoCompactThreshold(model) on
  // every API round; /model can change the session's active context window.
  // A number remains the explicit, fixed CLI/env test override.
  if (typeof thresholdTokens!=='function' &&
      (!Number.isSafeInteger(thresholdTokens) || thresholdTokens < 0)) {
    throw new RangeError('Compact threshold must be a non-negative integer.');
  }
  let consecutiveFailures = 0;
  return {
    async compact({ messages, model, signal, force = false } = {}) {
      aborted(signal);
      const currentThreshold=typeof thresholdTokens==='function'
        ? thresholdTokens(model?.model) : thresholdTokens;
      if(!Number.isSafeInteger(currentThreshold)||currentThreshold<0)
        throw new RangeError('Active model compact threshold must be a non-negative integer.');
      // Disabled compaction must be a strict no-op, including for providers
      // with non-text content blocks that this first port cannot estimate.
      if (currentThreshold === 0 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return { messages, compacted: false };
      }
      const estimatedTokens = estimateMessageTokens(messages);
      // 2.1.88 reactive recovery bypasses proactive threshold after the
      // server itself reports that the request cannot fit. Disabling compact
      // explicitly (threshold 0) remains authoritative.
      if (!force && estimatedTokens < currentThreshold) {
        return { messages, compacted: false, estimatedTokens };
      }
      const selection = selectCompletedPrefix(messages, keepRecentRounds);
      if (!selection) return { messages, compacted: false, estimatedTokens };
      const { prefix, recent } = selection;
      try {
        // Port 2.1.88 compact.ts truncateHeadForPTLRetry: when the summary
        // request is also too long, discard oldest WHOLE API-round groups,
        // retain the newest one for summarizing and add a user-role marker
        // if truncation made the first request message an assistant.
        let summarize = structuredClone(prefix);
        let text = '', completed = false, stopReason;
        for (let summaryAttempt = 0; summaryAttempt < 3; summaryAttempt++) {
          text = '';
          completed = false;
          stopReason = undefined;
          let sawSummaryEvent = false;
          try {
            const stream = model.stream({
              messages: normalizeMessagesForAPI([
                ...summarize,
                { role: 'user', content: SUMMARY_PROMPT },
              ]),
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
              sawSummaryEvent || summaryAttempt === 2) throw error;
            // Remove our own synthetic marker before regrouping. Otherwise
            // the next overflow would drop only that marker and make no
            // forward progress (the same bug guarded by 2.1.88 compact.ts).
            const source = summarize[0]?.role === 'user' &&
              summarize[0]?.content ===
                'Older conversation rounds omitted because the summary request exceeded context.'
              ? summarize.slice(1) : summarize;
            const groups = groupMessagesByApiRound(source);
            if (groups.length < 2) throw error;
            const removed = Math.max(1, Math.floor(groups.length * 0.2));
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
            summary + '\nRecent messages follow unchanged.' },
          ...structuredClone(recent),
        ];
        // The original compact.ts commits its summary as a new context
        // boundary. The retained assistant's usage is from BEFORE compaction,
        // so tokenCountWithEstimation(next) cannot estimate the new boundary.
        // Count the new message content using the original roughTokenCount...
        // implementation until the next real model API response arrives.
        // The former arbitrary 80% shrink test was not in original compact.ts.
        const nextTokens = estimateFreshCompactedCliMessages(next);
        consecutiveFailures = 0;
        return {
          messages: next, compacted: true,
          estimatedTokens, compactedTokens: nextTokens,
          removedMessages: prefix.length,
        };
      } catch (error) {
        if (signal?.aborted) aborted(signal);
        consecutiveFailures++;
        // Original conversation stays intact. Never half-commit a summary.
        throw error;
      }
    },
    get consecutiveFailures() { return consecutiveFailures; },
  };
}
