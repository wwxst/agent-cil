/**
 * Direct JavaScript port of CLI 2.1.88:
 * restored-src/src/utils/tokens.ts and the rough estimator functions from
 * restored-src/src/services/tokenEstimation.ts. Method names, API usage
 * anchoring and parallel-response sibling traversal are preserved.
 *
 * This module consumes legacy Message envelopes. The Node CLI's {role,
 * content,usage} transport shape is converted only at its calling boundary.
 */
const SYNTHETIC_MODEL = '<synthetic>';
// Literal exports from original 2.1.88 restored-src/src/utils/messages.ts.
// Synthetic tool-control responses are not billable assistant API usage.
const SYNTHETIC_MESSAGES = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
  'No response requested.',
]);
const jsonStringify = JSON.stringify;

export function roughTokenCountEstimation(content, bytesPerToken = 4) {
  return Math.round(content.length / bytesPerToken);
}
export function roughTokenCountEstimationForMessages(messages) {
  let totalTokens = 0;
  for (const message of messages) totalTokens += roughTokenCountEstimationForMessage(message);
  return totalTokens;
}
export function roughTokenCountEstimationForMessage(message) {
  if ((message.type === 'assistant' || message.type === 'user') && message.message?.content) {
    return roughTokenCountEstimationForContent(message.message.content);
  }
  // Unsupported attachment envelopes must never be silently counted as zero;
  // count the serialized data conservatively until the real attachment
  // normalization dependency is ported.
  if (message.type === 'attachment' && message.attachment) {
    return roughTokenCountEstimation(jsonStringify(message.attachment));
  }
  return 0;
}
function roughTokenCountEstimationForContent(content) {
  if (!content) return 0;
  if (typeof content === 'string') return roughTokenCountEstimation(content);
  let totalTokens = 0;
  for (const block of content) totalTokens += roughTokenCountEstimationForBlock(block);
  return totalTokens;
}
function roughTokenCountEstimationForBlock(block) {
  if (typeof block === 'string') return roughTokenCountEstimation(block);
  if (block.type === 'text') return roughTokenCountEstimation(block.text);
  if (block.type === 'image' || block.type === 'document') return 2000;
  if (block.type === 'tool_result') return roughTokenCountEstimationForContent(block.content);
  if (block.type === 'tool_use') return roughTokenCountEstimation(block.name + jsonStringify(block.input ?? {}));
  if (block.type === 'thinking') return roughTokenCountEstimation(block.thinking);
  if (block.type === 'redacted_thinking') return roughTokenCountEstimation(block.data);
  return roughTokenCountEstimation(jsonStringify(block));
}

export function getTokenUsage(message) {
  if (message?.type === 'assistant' &&
      'usage' in message.message &&
      !(message.message.content[0]?.type === 'text' &&
        SYNTHETIC_MESSAGES.has(message.message.content[0].text)) &&
      message.message.model !== SYNTHETIC_MODEL) {
    return message.message.usage;
  }
  return undefined;
}
function getAssistantMessageId(message) {
  if (message?.type === 'assistant' &&
      'id' in message.message &&
      message.message.model !== SYNTHETIC_MODEL) {
    return message.message.id;
  }
  return undefined;
}
export function getTokenCountFromUsage(usage) {
  return usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens;
}
export function tokenCountFromLastAPIResponse(messages) {
  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    const usage = message ? getTokenUsage(message) : undefined;
    if (usage) return getTokenCountFromUsage(usage);
    i--;
  }
  return 0;
}
export function finalContextTokensFromLastResponse(messages) {
  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    const usage = message ? getTokenUsage(message) : undefined;
    if (usage) {
      const iterations = usage.iterations;
      if (iterations && iterations.length > 0) {
        const last = iterations.at(-1);
        return last.input_tokens + last.output_tokens;
      }
      return usage.input_tokens + usage.output_tokens;
    }
    i--;
  }
  return 0;
}
export function messageTokenCountFromLastAPIResponse(messages) {
  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    const usage = message ? getTokenUsage(message) : undefined;
    if (usage) return usage.output_tokens;
    i--;
  }
  return 0;
}
export function getCurrentUsage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const usage = message ? getTokenUsage(message) : undefined;
    if (usage) return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    };
  }
  return null;
}
export function doesMostRecentAssistantMessageExceed200k(messages) {
  const THRESHOLD = 200_000;
  const lastAsst = messages.findLast(m => m.type === 'assistant');
  if (!lastAsst) return false;
  const usage = getTokenUsage(lastAsst);
  return usage ? getTokenCountFromUsage(usage) > THRESHOLD : false;
}
export function getAssistantMessageContentLength(message) {
  let contentLength = 0;
  for (const block of message.message.content) {
    if (block.type === 'text') contentLength += block.text.length;
    else if (block.type === 'thinking') contentLength += block.thinking.length;
    else if (block.type === 'redacted_thinking') contentLength += block.data.length;
    else if (block.type === 'tool_use') contentLength += jsonStringify(block.input).length;
  }
  return contentLength;
}
export function tokenCountWithEstimation(messages) {
  let i = messages.length - 1;
  while (i >= 0) {
    const message = messages[i];
    const usage = message ? getTokenUsage(message) : undefined;
    if (message && usage) {
      const responseId = getAssistantMessageId(message);
      if (responseId) {
        let j = i - 1;
        while (j >= 0) {
          const prior = messages[j];
          const priorId = prior ? getAssistantMessageId(prior) : undefined;
          if (priorId === responseId) i = j;
          else if (priorId !== undefined) break;
          j--;
        }
      }
      return getTokenCountFromUsage(usage) +
        roughTokenCountEstimationForMessages(messages.slice(i + 1));
    }
    i--;
  }
  return roughTokenCountEstimationForMessages(messages);
}
