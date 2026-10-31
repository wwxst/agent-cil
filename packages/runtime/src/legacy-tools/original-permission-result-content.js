/**
 * Runnable port of 2.1.88 toolExecution.ts
 * checkPermissionsAndCallTool().addToolResult() around lines 1418-1441.
 * 2.1.304 compiled executor retains both acceptFeedback and contentBlocks.
 *
 * The source appends these blocks after the authenticated tool_result. Node
 * must validate its adapter boundary so an external approval handler cannot
 * forge another tool_result, tool_use or a malformed image in history.
 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_TEXT = 64 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BLOCKS = 32;

export function getOriginalPermissionContentBlocks(permissionDecision, approvedFeedback) {
  const blocks = [];
  // Original result path uses permissionDecision.acceptFeedback; an explicit
  // user approval may supply it through the Node approval adapter.
  const decision = approvedFeedback
    ? { ...permissionDecision,
        ...(approvedFeedback.acceptFeedback !== undefined
          ? { acceptFeedback: approvedFeedback.acceptFeedback } : {}),
        ...(approvedFeedback.contentBlocks !== undefined
          ? { contentBlocks: approvedFeedback.contentBlocks } : {}) }
    : permissionDecision;
  if (!decision || typeof decision !== 'object' || decision.behavior !== 'allow') {
    // Approval handler can resolve an original ask; the outer caller is
    // responsible for asserting that it really became an allowed decision.
    if (!approvedFeedback) return blocks;
  }
  if (decision?.acceptFeedback !== undefined) {
    if (typeof decision.acceptFeedback !== 'string' ||
        Buffer.byteLength(decision.acceptFeedback) > MAX_TEXT) {
      throw new TypeError('Invalid permission acceptFeedback.');
    }
    if (decision.acceptFeedback) blocks.push({ type: 'text', text: decision.acceptFeedback });
  }
  if (decision?.contentBlocks !== undefined) {
    if (!Array.isArray(decision.contentBlocks) ||
        decision.contentBlocks.length > MAX_BLOCKS) {
      throw new TypeError('Invalid permission contentBlocks.');
    }
    for (const block of decision.contentBlocks) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new TypeError('Invalid permission content block.');
      }
      if (block.type === 'text') {
        if (typeof block.text !== 'string' || Buffer.byteLength(block.text) > MAX_TEXT) {
          throw new TypeError('Invalid permission text block.');
        }
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const src = block.source;
        if (src?.type !== 'base64' || !IMAGE_TYPES.has(src.media_type) ||
            typeof src.data !== 'string' ||
            src.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 ||
            src.data.length === 0 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(src.data)) {
          throw new TypeError('Invalid permission image block.');
        }
        blocks.push({ type: 'image',
          source: { type: 'base64', media_type: src.media_type, data: src.data } });
      } else {
        // Do not accept permission-provided tool_result/tool_use masquerading
        // as additional messages. Non-text/image content needs an explicit
        // original parser/source port rather than a silent pass-through.
        throw new TypeError('Unsupported permission content block type: ' + String(block.type));
      }
    }
  }
  return blocks;
}
