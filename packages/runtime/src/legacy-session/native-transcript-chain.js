/**
 * Portable dependency closure for CLI 2.1.88 sessionStorage.ts:
 * insertMessageChain() (~994–1077), isTranscriptMessage(), and
 * getLastSessionLog() / buildConversationChain().
 *
 * Native source stores UUID-linked TranscriptMessages and uses
 * sourceToolAssistantUUID as the preferred tool-result parent. Our Node
 * transport has {role,content} objects rather than Bun Message wrappers.
 * Keep this adapter explicit; do not claim this is the entire Session schema.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

function isRecord(value) {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}
function isUUID(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function toolUses(message) {
  return message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === 'tool_use').map(block => block.id)
    : [];
}
function toolResults(message) {
  return message.role === 'user' && Array.isArray(message.content)
    ? message.content.filter(block => block?.type === 'tool_result').map(block => block.tool_use_id)
    : [];
}

/** Source-like insertMessageChain, limited to committed Node conversation
 * user/assistant messages. An unchanged prefix appends only the delta.
 * A compaction has an explicit new root (parentUuid=null, logicalParentUuid
 * points to the prior leaf), as in the original source's compact boundary.
 */
export function insertMessageChain({
  messages, previousMessages = [], previousLeaf = null,
  sessionId, kind, isMigration = false,
} = {}) {
  if (!Array.isArray(messages) || !Array.isArray(previousMessages) ||
      !isUUID(sessionId)) throw new TypeError('Invalid source message-chain inputs.');
  const samePrefix = previousMessages.length <= messages.length &&
    previousMessages.every((message,index) => isDeepStrictEqual(message,messages[index]));
  if (!samePrefix && kind !== 'compact') {
    throw new Error('Non-compact session transition rewrites already committed messages.');
  }
  const root = !samePrefix || isMigration || previousMessages.length === 0;
  const start = root ? 0 : previousMessages.length;
  const entries = [];
  let parentUuid = root ? null : previousLeaf;
  let toolAssistantUuid;
  let toolAssistantUseIDs;
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message) || !['user','assistant'].includes(message.role))
      throw new TypeError('Only committed source user/assistant messages can enter a chain.');
    if (message.role === 'assistant') {
      toolAssistantUseIDs = toolUses(message);
      toolAssistantUuid = toolAssistantUseIDs.length ? undefined : null;
    }
    const resultingIDs = toolResults(message);
    let sourceToolAssistantUUID;
    if (resultingIDs.length) {
      const prior = entries.at(-1);
      const source = prior?.type === 'assistant' ? prior
        : (!root && entries.length===0 && previousMessages.at(-1)?.role==='assistant'
          ? null : undefined);
      // In a completed source tool batch, the result's logical parent is
      // the assistant tool_use message, never an arbitrary user prompt.
      if (source && resultingIDs.every(id => toolUses(source.message).includes(id))) {
        sourceToolAssistantUUID = source.uuid;
      } else if (toolAssistantUuid && resultingIDs.every(id => toolAssistantUseIDs?.includes(id))) {
        sourceToolAssistantUUID = toolAssistantUuid;
      } else {
        // Existing prefix can end at a tool_use assistant; the caller must
        // supply its UUID from an indexed source record, not guess one.
        if (!root && entries.length===0) {
          throw new Error('Cannot link a tool_result without its committed assistant UUID.');
        }
        throw new Error('Tool results do not belong to the adjacent assistant tool_use.');
      }
    }
    const uuid = randomUUID();
    const entry = {
      type:message.role, uuid,
      parentUuid:sourceToolAssistantUUID ?? parentUuid,
      ...(root && i===0 && previousLeaf
        ? {logicalParentUuid:previousLeaf}:{}),
      ...(sourceToolAssistantUUID?{sourceToolAssistantUUID}:{}),
      sessionId, message:structuredClone(message),
    };
    entries.push(entry);
    parentUuid=uuid;
    if(message.role==='assistant' && toolAssistantUseIDs?.length) {
      toolAssistantUuid=uuid;
    }
  }
  return {entries, leafUuid:parentUuid, root};
}

/** Reconstruct the source parentUuid chain from the last committed leaf,
 * instead of treating an arbitrary snapshot or uncommitted leaf as history.
 */
export function buildConversationChain(messageMap, leafUuid) {
  if (!(messageMap instanceof Map) || !isUUID(leafUuid))
    throw new TypeError('Invalid source conversation chain input.');
  const visited = new Set(), chain = [];
  let currentUuid = leafUuid;
  while (currentUuid !== null) {
    if (visited.has(currentUuid))throw new Error('Session parentUuid cycle.');
    visited.add(currentUuid);
    const node=messageMap.get(currentUuid);
    if (!node)throw new Error('Missing session parentUuid: '+currentUuid);
    chain.push(structuredClone(node.message));
    currentUuid=node.parentUuid;
  }
  return chain.reverse();
}

/** Validate the entire *committed* chain delta before installing it.
 * Unreferenced/half-written messages may not advance the committed leaf.
 */
export function applyMessageChain({existing = new Map(),entries,leafUuid,sessionId,
  allowRoot=false,previousLeaf=null} = {}) {
  if (!(existing instanceof Map) || !Array.isArray(entries) ||
      !isUUID(sessionId) || !isUUID(leafUuid) ||
      entries.length===0) throw new TypeError('Malformed session chain commit.');
  const next = new Map(existing);
  let expectedParent=allowRoot ? null : previousLeaf;
  for(let i=0;i<entries.length;i++){
    const entry=entries[i];
    if(!isRecord(entry) || !['user','assistant'].includes(entry.type) ||
       !isUUID(entry.uuid) || entry.sessionId!==sessionId ||
       !isRecord(entry.message) || entry.message.role!==entry.type ||
       typeof entry.message.content!=='string'&&!Array.isArray(entry.message.content) ||
       next.has(entry.uuid))throw new Error('Invalid or duplicate session chain entry.');
    if (i===0 && allowRoot && entry.parentUuid!==null)
      throw new Error('Session compact/migration boundary must start a root.');
    if (entry.parentUuid!==expectedParent)
      throw new Error('Session parentUuid chain is broken.');
    if(entry.sourceToolAssistantUUID!==undefined){
      const source=next.get(entry.sourceToolAssistantUUID);
      const ids=toolResults(entry.message);
      if(entry.type!=='user' || !source ||
        source.type!=='assistant' || !ids.length ||
        !ids.every(id=>toolUses(source.message).includes(id)) ||
        entry.parentUuid!==entry.sourceToolAssistantUUID) {
        throw new Error('Invalid sourceToolAssistantUUID association.');
      }
    } else if(toolResults(entry.message).length){
      throw new Error('Tool result requires sourceToolAssistantUUID.');
    }
    if(i===0 && entry.logicalParentUuid!==undefined &&
      (!allowRoot || entry.logicalParentUuid!==previousLeaf))
      throw new Error('Invalid logicalParentUuid compact boundary.');
    next.set(entry.uuid,structuredClone(entry));
    expectedParent=entry.uuid;
  }
  if(expectedParent!==leafUuid)throw new Error('Invalid committed leafUuid.');
  return {map:next,messages:buildConversationChain(next,leafUuid)};
}
