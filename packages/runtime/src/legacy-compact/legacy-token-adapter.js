/** Node message envelope and incomplete-SSE usage adapter ONLY.
 * The actual accounting functions are ported from 2.1.88 tokens.ts. */
import { tokenCountWithEstimation, getCurrentUsage,
  roughTokenCountEstimationForMessages } from './legacy-tokens.js';

export function hasCompleteApiUsage(usage) {
  return usage !== null && typeof usage === 'object' &&
    Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 &&
    Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0 &&
    ['cache_creation_input_tokens', 'cache_read_input_tokens'].every(field =>
      usage[field] === undefined ||
      (Number.isSafeInteger(usage[field]) && usage[field] >= 0));
}

export function toLegacyMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array.');
  return messages.map(message => {
    if (!message || !['user', 'assistant'].includes(message.role) ||
        (typeof message.content !== 'string' && !Array.isArray(message.content))) {
      throw new TypeError('Invalid current CLI message for token accounting.');
    }
    const usage = hasCompleteApiUsage(message.usage) ? { usage: message.usage } : {};
    return {
      type: message.role,
      message: {
        content: message.content,
        ...(message.id ? { id: message.id } : {}),
        ...usage,
        model: message.model,
      },
    };
  });
}

export function tokenCountForCliMessages(messages) {
  return tokenCountWithEstimation(toLegacyMessages(messages));
}
export function currentUsageForCliMessages(messages) {
  return getCurrentUsage(toLegacyMessages(messages));
}

/** The original compaction boundary has no fresh API response yet.
 * Do not re-use the retained suffix's PRE-compaction API usage as a
 * POST-compaction token measurement. */
export function estimateFreshCompactedCliMessages(messages) {
  return roughTokenCountEstimationForMessages(toLegacyMessages(messages));
}
