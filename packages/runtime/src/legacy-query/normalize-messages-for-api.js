/**
 * CLI 2.1.88 utils/messages.ts normalizeMessagesForAPI() boundary:
 * transcript/session retains separate completed tool_result user messages;
 * request adapters merge consecutive result-bearing users into a single
 * protocol turn. Preserve all tool_result IDs and stable result order before
 * permission/Hook/native content, without rewriting the durable source chain.
 *
 * This is the narrow headless Node content-block dependency closure, not the
 * original complete message/attachment normalization implementation.
 */
export function normalizeMessagesForAPI(messages) {
  if(!Array.isArray(messages))throw new TypeError('messages must be an array.');
  const normalized=[];
  for(const source of messages){
    const message=structuredClone(source);
    const previous=normalized.at(-1);
    if(previous?.role==='user' && message.role==='user' &&
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
  return normalized;
}
