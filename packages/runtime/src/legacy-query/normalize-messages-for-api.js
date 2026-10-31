function isToolResultMessage(message) {
  return message?.role === 'user' && Array.isArray(message.content) &&
    message.content.some(block => block?.type === 'tool_result');
}

/**
 * CLI 2.1.88 utils/messages.ts normalizeMessagesForAPI() boundary:
 * transcript/session retains separate completed tool_result user messages;
 * request adapters merge consecutive result-bearing users and same-ID
 * assistant fragments into the provider's protocol turns. Preserve all
 * tool_result IDs and stable result order before
 * permission/Hook/native content, without rewriting the durable source chain.
 *
 * This is the narrow headless Node content-block dependency closure, not the
 * original complete message/attachment normalization implementation.
 */
export function normalizeMessagesForAPI(messages) {
  if(!Array.isArray(messages))throw new TypeError('messages must be an array.');
  const normalized=[];
  for(const source of messages){
    if (source?.isApiErrorMessage === true) continue;
    const message=structuredClone(source);
    const previous=normalized.at(-1);
    const assistantId = message.role === 'assistant'
      ? (message.sourceMessageId ?? message.id) : undefined;
    if (assistantId !== undefined && assistantId !== null) {
      // Match the source backward walk: skip tool-result users and assistant
      // fragments with other IDs, but stop at any unrelated message.
      let merged = false;
      for (let i = normalized.length - 1; i >= 0; i--) {
        const candidate = normalized[i];
        if (candidate?.role !== 'assistant' && !isToolResultMessage(candidate)) break;
        if (candidate?.role === 'assistant' &&
            (candidate.sourceMessageId ?? candidate.id) === assistantId) {
          normalized[i] = {
            ...candidate,
            content: [
              ...(Array.isArray(candidate.content) ? candidate.content : []),
              ...(Array.isArray(message.content) ? message.content : []),
            ],
          };
          merged = true;
          break;
        }
      }
      if (merged) continue;
    }
    const isOutputLimitRecovery =
      message.role === 'user' &&
      message.isMeta === true &&
      typeof message.content === 'string' &&
      message.content.startsWith('Output token limit hit.');
    if (previous?.role === 'user' && message.role === 'user' &&
        isOutputLimitRecovery) {
      const left = typeof previous.content === 'string'
        ? [{ type: 'text', text: previous.content }]
        : Array.isArray(previous.content) ? previous.content : [];
      const right = [{ type: 'text', text: message.content }];
      const last = left.at(-1);
      if (last?.type === 'text') {
        left[left.length - 1] = { ...last, text: last.text + '\n' };
      }
      const merged = [...left, ...right];
      const results = merged.filter(block => block?.type === 'tool_result');
      const ancillary = merged.filter(block => block?.type !== 'tool_result');
      previous.content = [...results, ...ancillary];
    } else if(previous?.role==='user' && message.role==='user' &&
       Array.isArray(previous.content) && Array.isArray(message.content) &&
       (previous.content.some(block=>block?.type==='tool_result') ||
        message.content.some(block=>block?.type==='tool_result'))) {
      previous.content.push(...message.content);
    }else normalized.push(message);
  }
  for(const message of normalized){
    if(message.role!=='user' || !Array.isArray(message.content) ||
       !message.content.some(block=>block?.type==='tool_result'))continue;
    const results=message.content.filter(block=>block?.type==='tool_result');
    const ancillary=message.content.filter(block=>block?.type!=='tool_result');
    message.content=[...results,...ancillary];
  }
  // Assistant IDs are transcript bookkeeping, not part of provider messages.
  return normalized.map(message => {
    if (message?.role !== 'assistant') return message;
    if (!Object.hasOwn(message, 'id') &&
        !Object.hasOwn(message, 'sourceMessageId')) return message;
    const { id: _id, sourceMessageId: _sourceMessageId, ...apiMessage } = message;
    return apiMessage;
  });
}
