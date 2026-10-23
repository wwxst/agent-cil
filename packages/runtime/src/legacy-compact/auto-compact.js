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
export function createAutoCompact({ thresholdTokens, keepRecentRounds = 2 } = {}) {
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens < 0) {
    throw new RangeError('Compact threshold must be a non-negative integer.');
  }
  let consecutiveFailures = 0;
  return {
    async compact({ messages, model, signal, force = false } = {}) {
      aborted(signal);
      // Disabled compaction must be a strict no-op, including for providers
      // with non-text content blocks that this first port cannot estimate.
      if (thresholdTokens === 0 || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return { messages, compacted: false };
      }
      const estimatedTokens = estimateMessageTokens(messages);
      // 2.1.88 reactive recovery bypasses proactive threshold after the
      // server itself reports that the request cannot fit. Disabling compact
      // explicitly (threshold 0) remains authoritative.
      if (!force && estimatedTokens < thresholdTokens) {
        return { messages, compacted: false, estimatedTokens };
      }
      const selection = selectCompletedPrefix(messages, keepRecentRounds);
      if (!selection) return { messages, compacted: false, estimatedTokens };
      const { prefix, recent } = selection;
      let text = '', completed = false, stopReason;
      try {
        const stream = model.stream({
          messages: [
            ...structuredClone(prefix),
            { role: 'user', content: SUMMARY_PROMPT },
          ],
          tools: [], signal, purpose: 'compact',
        });
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
          throw new Error('Summary model did not return an event stream.');
        }
        for await (const event of stream) {
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
            // No model-generated tools or unknown protocol events during compact.
            throw new Error('Unexpected tool or protocol event during summary.');
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
        const nextTokens = estimateMessageTokens(next);
        if (nextTokens >= estimatedTokens * 0.8) {
          throw new Error('Summary did not sufficiently reduce context size.');
        }
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
