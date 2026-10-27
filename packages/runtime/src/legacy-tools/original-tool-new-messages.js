/**
 * Node dependency closure for old 2.1.88 toolExecution.ts lines 1565–1569:
 * native Tool.call().newMessages is emitted AFTER the committed tool result
 * and PostToolUse updates, not silently discarded or made into tool output.
 *
 * Original utils/messages.ts normalizeMessagesForAPI merges consecutive
 * UserMessages. This headless adapter supports normal source UserMessage
 * instances ({type:'user',message:{role:'user',content}}) plus the existing
 * Node {role:'user',content} form. Preserve text/images as adjacent user
 * content blocks after all tool results; never permit embedded tool_result,
 * tool_use or assistant impersonation on this boundary. Other original
 * Message union members need their corresponding native dependency closure.
 */
const MAX_MESSAGES = 32;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png','image/jpeg','image/gif','image/webp']);
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function cloneContentBlock(block) {
  if (!isRecord(block)) throw new TypeError('Invalid native newMessages block.');
  if (block.type === 'text') {
    if (typeof block.text !== 'string' || Buffer.byteLength(block.text) > MAX_TEXT_BYTES) {
      throw new TypeError('Unsupported native newMessages text block.');
    }
    return { type:'text',text:block.text };
  }
  if (block.type === 'image') {
    const src=block.source;
    if (!isRecord(src) || src.type !== 'base64' ||
        !IMAGE_TYPES.has(src.media_type) ||
        typeof src.data !== 'string' || src.data.length===0 ||
        src.data.length > MAX_IMAGE_BASE64_CHARS ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(src.data)) {
      throw new TypeError('Unsupported native newMessages image.');
    }
    return { type:'image',source:{type:'base64',media_type:src.media_type,data:src.data} };
  }
  // Deliberately no tool_result or tool_use: these must come from the
  // authenticated scheduler, not from arbitrary Tool.call() newMessages.
  throw new TypeError('Unsupported native newMessages content block: '+String(block.type));
}
export function normalizeOriginalToolNewMessagesForAPI(newMessages) {
  if (newMessages === undefined) return [];
  if (!Array.isArray(newMessages) || newMessages.length > MAX_MESSAGES) {
    throw new TypeError('Native tool newMessages must be a bounded array.');
  }
  const blocks=[];
  for(const original of newMessages) {
    if (!isRecord(original)) throw new TypeError('Malformed native tool newMessages entry.');
    const message=original.type==='user' && isRecord(original.message)
      ? original.message : original;
    if ((original.type !== 'user' && original.role !== 'user') ||
        message.role !== 'user') {
      throw new TypeError('Unsupported native newMessages message type: '+String(original.type ?? original.role));
    }
    if (typeof message.content === 'string') {
      if (Buffer.byteLength(message.content)>MAX_TEXT_BYTES) {
        throw new TypeError('Native tool newMessages text exceeds limit.');
      }
      blocks.push({type:'text',text:message.content});
    } else if (Array.isArray(message.content)) {
      for(const block of message.content) blocks.push(cloneContentBlock(block));
    } else {
      throw new TypeError('Malformed native user newMessages content.');
    }
    if (blocks.length > MAX_MESSAGES*16) {
      throw new RangeError('Native tool newMessages contain too many blocks.');
    }
  }
  return blocks;
}
