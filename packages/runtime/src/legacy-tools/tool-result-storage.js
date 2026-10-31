/**
 * Node adaptation of the 2.1.88 toolResultStorage decision algorithm with
 * aggregate-candidate and skip semantics checked against CLI 2.1.304.
 * Filesystem persistence is adapted to the per-session Node storage context.
 */
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

export const TOOL_RESULTS_SUBDIR = 'tool-results';
export const PERSISTED_OUTPUT_TAG = '<persisted-output>';
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]';
export const PREVIEW_SIZE_BYTES = 2000;
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
export const MAX_TOOL_RESULT_BYTES = 400_000;
export const MAX_PERSISTED_TOOL_RESULT_BYTES = 1_073_741_824;
export const BYTES_PER_TOKEN = 4;
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;
export const ARTIFACT_CONTENT_AUTHORED_BY_OTHERS_PREFIX = '<artifact-content-authored-by-others/>\n';

export function getPersistenceThreshold(
  toolName,
  declaredMaxResultSizeChars = DEFAULT_MAX_RESULT_SIZE_CHARS,
  persistenceThresholdCeiling = DEFAULT_MAX_RESULT_SIZE_CHARS,
  skipAggregateToolResultBudget = false,
) {
  if (!Number.isFinite(declaredMaxResultSizeChars)) return declaredMaxResultSizeChars;
  if (typeof persistenceThresholdCeiling !== 'number' ||
      !(persistenceThresholdCeiling > 0 || persistenceThresholdCeiling === Infinity)) {
    throw new TypeError('persistenceThresholdCeiling must be positive or Infinity.');
  }
  // 2.1.304's tengu_velvet_ibis override is GrowthBook-backed. This local
  // CLI has no GrowthBook client, so use the source fallback ceiling. The
  // skip flag bypasses that remote override in the source as well.
  void toolName;
  void skipAggregateToolResultBudget;
  return Math.min(declaredMaxResultSizeChars, persistenceThresholdCeiling);
}

function assertStorageContext(storage) {
  if (!storage || typeof storage.directory !== 'string' || typeof storage.workspace !== 'string') {
    throw new TypeError('Tool result persistence requires a workspace and directory.');
  }
  if (storage.maxPersistBytes !== undefined &&
      (!Number.isSafeInteger(storage.maxPersistBytes) || storage.maxPersistBytes < 1)) {
    throw new TypeError('maxPersistBytes must be a positive safe integer.');
  }
  return storage;
}
function assertSafeToolUseID(toolUseID) {
  if (typeof toolUseID !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(toolUseID)) {
    throw new TypeError('Unsafe tool_use ID for tool result storage.');
  }
  return toolUseID;
}
export function getToolResultsDir(storage) {
  return resolve(assertStorageContext(storage).directory);
}
export function getToolResultPath(id, isJson, storage) {
  const ext = isJson ? 'json' : 'txt';
  return join(getToolResultsDir(storage), assertSafeToolUseID(id) + '.' + ext);
}
function truncateUtf8Bytes(content, maxBytes) {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let usedBytes = 0;
  let end = 0;
  // Iterate Unicode code points so the persisted prefix never ends inside a
  // UTF-8 sequence or a UTF-16 surrogate pair.
  for (const character of content) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (usedBytes + bytes > maxBytes) break;
    usedBytes += bytes;
    end += character.length;
  }
  return content.slice(0, end);
}

async function ensureNoSymlink(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symlink not permitted for persisted tool result: ' + path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
export async function ensureToolResultsDir(storage) {
  const lexicalRoot = resolve(assertStorageContext(storage).workspace);
  const root = await realpath(lexicalRoot);
  const directory = getToolResultsDir(storage);
  // On Windows a workspace may be a junction/short-name path and realpath()
  // may change its prefix. Check the requested path lexically first, then
  // confirm its resolved destination against the canonical root below.
  const rel = relative(lexicalRoot, directory);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !rel) {
    throw new Error('Tool results directory must be inside the workspace.');
  }
  let current = lexicalRoot;
  for (const component of rel.split(sep)) {
    current = join(current, component);
    await ensureNoSymlink(current);
    await mkdir(current, { recursive: false, mode: 0o700 }).catch(error => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await ensureNoSymlink(current);
  }
  const actual = await realpath(directory);
  const check = relative(root, actual);
  if (check === '..' || check.startsWith('..' + sep) || isAbsolute(check)) {
    throw new Error('Persisted tool result directory escapes workspace.');
  }
}

export async function persistToolResult(content, toolUseId, storage) {
  const isJson = Array.isArray(content);
  if (isJson && content.some(block =>
    !block || typeof block !== 'object' || Array.isArray(block) ||
    block.type !== 'text' || typeof block.text !== 'string')) {
    return { error: 'Cannot persist tool results containing non-text content' };
  }
  await ensureToolResultsDir(storage);
  const filepath = getToolResultPath(toolUseId, isJson, storage);
  const contentStr = isJson ? JSON.stringify(content, null, 2) : content;
  // 2.1.304 caps persisted tool output at 1 GiB (or a lower storage-provider
  // limit). The full original result remains in the session transcript.
  const maxPersistBytes = storage.maxPersistBytes ?? MAX_PERSISTED_TOOL_RESULT_BYTES;
  const persistedContent = truncateUtf8Bytes(contentStr, maxPersistBytes);
  const truncatedAtBytes = persistedContent === contentStr ? undefined : maxPersistBytes;
  try {
    await writeFile(filepath, persistedContent, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return {
      error: error instanceof Error ? error.message : String(error),
    };
    // The 2.1.88 exclusive-write assumption requires the existing path to
    // contain the deterministic bytes for this toolUseId. A directory,
    // symlink, or content collision is NOT a completed previous result.
    try {
      const info = await lstat(filepath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
        return { error: 'Existing tool result path is not a private regular file.' };
      }
      const previous = await readFile(filepath, 'utf8');
      if (previous !== persistedContent) {
        return { error: 'Stored tool result differs for the same tool_use ID.' };
      }
    } catch (readError) {
      return { error: readError instanceof Error ? readError.message : String(readError) };
    }
  }
  const previewInfo = generatePreview(persistedContent, PREVIEW_SIZE_BYTES);
  return {
    filepath, originalSize: contentStr.length, isJson, ...previewInfo,
    ...(truncatedAtBytes !== undefined ? { truncatedAtBytes } : {}),
  };
}

export function buildLargeToolResultMessage(result) {
  const formatFileSize = bytes => bytes < 1024 ? bytes + ' B' :
    bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' :
    (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  let message = PERSISTED_OUTPUT_TAG + '\n';
  if (result.truncatedAtBytes !== undefined) {
    const limit = formatFileSize(result.truncatedAtBytes);
    message += 'Output exceeded the ' + limit + ' persist limit; only the first ' +
      limit + ' were saved to: ' + result.filepath + '\n\n';
  } else {
    message += 'Output too large (' + formatFileSize(result.originalSize) +
      '). Full output saved to: ' + result.filepath + '\n\n';
  }
  message += 'Preview (first ' + formatFileSize(PREVIEW_SIZE_BYTES) + '):\n';
  message += result.preview;
  message += result.hasMore ? '\n...\n' : '\n';
  message += PERSISTED_OUTPUT_CLOSING_TAG;
  return message;
}

export async function processToolResultBlock(tool, toolUseResult, toolUseID, storage) {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(toolUseResult, toolUseID);
  return maybePersistLargeToolResult(toolResultBlock, tool.name,
    getPersistenceThreshold(
      tool.name, tool.maxResultSizeChars, tool.persistenceThresholdCeiling,
      tool.skipAggregateToolResultBudget,
    ), storage);
}
export async function processPreMappedToolResultBlock(
  toolResultBlock, toolName, maxResultSizeChars, storage,
  persistenceThresholdCeiling = DEFAULT_MAX_RESULT_SIZE_CHARS,
  skipAggregateToolResultBudget = false,
) {
  return maybePersistLargeToolResult(toolResultBlock, toolName,
    getPersistenceThreshold(
      toolName, maxResultSizeChars, persistenceThresholdCeiling,
      skipAggregateToolResultBudget,
    ), storage);
}
export function isToolResultContentEmpty(content) {
  if (!content) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every(block => block !== null && typeof block === 'object' &&
    !Array.isArray(block) && 'type' in block && block.type === 'text' &&
    'text' in block && (typeof block.text !== 'string' || block.text.trim() === ''));
}
function hasUnsupportedMediaBlock(content) {
  return Array.isArray(content) &&
    content.some(block => typeof block === 'object' && block !== null &&
      (block.type === 'image' || block.type === 'document'));
}
function contentSize(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) =>
    sum + (block?.type === 'text' && typeof block.text === 'string'
      ? block.text.length : 0), 0);
}
async function maybePersistLargeToolResult(toolResultBlock, toolName, persistenceThreshold, storage) {
  const content = toolResultBlock.content;
  if (isToolResultContentEmpty(content)) {
    return { ...toolResultBlock, content: '(' + toolName + ' completed with no output)' };
  }
  if (!content) return toolResultBlock;
  if (hasUnsupportedMediaBlock(content)) return toolResultBlock;
  const size = contentSize(content);
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES;
  if (size <= threshold) return toolResultBlock;
  const result = await persistToolResult(content, toolResultBlock.tool_use_id, storage);
  if (isPersistError(result)) {
    // Original behavior: persistence failure retains the unmodified tool result.
    return toolResultBlock;
  }
  return { ...toolResultBlock, content: buildLargeToolResultMessage(result) };
}

export function generatePreview(content, maxBytes) {
  if (content.length <= maxBytes) return { preview: content, hasMore: false };
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}
export function isPersistError(result) {
  return 'error' in result;
}


/**
 * Per-conversation decision state from 2.1.88 toolResultStorage.ts.
 * Once a tool result has been sent to the model, its replacement decision is
 * frozen. This keeps the provider-visible prefix byte-identical on later turns.
 */
export function createContentReplacementState() {
  return { seenIds: new Set(), replacements: new Map() };
}

function isContentAlreadyCompacted(content) {
  if (typeof content !== 'string') return false;
  const unwrapped = content.startsWith(ARTIFACT_CONTENT_AUTHORED_BY_OTHERS_PREFIX)
    ? content.slice(ARTIFACT_CONTENT_AUTHORED_BY_OTHERS_PREFIX.length)
    : content;
  return unwrapped.startsWith(PERSISTED_OUTPUT_TAG) ||
    unwrapped === TOOL_RESULT_CLEARED_MESSAGE;
}

function collectCandidatesFromMessage(message) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return [];
  return message.content.flatMap(block => {
    // 2.1.304's aggregate candidate collector deliberately keeps error and
    // truncated-output results; only persisted/cleared output and non-text
    // media are excluded here.
    if (block?.type !== 'tool_result' || !block.content ||
        isContentAlreadyCompacted(block.content) ||
        hasUnsupportedMediaBlock(block.content)) return [];
    return [{
      toolUseId: block.tool_use_id,
      content: block.content,
      size: contentSize(block.content),
    }];
  });
}

/**
 * The API normalizer merges adjacent result users and assistant fragments by
 * message ID. Group tool results on that exact source boundary or parallel
 * batches can bypass the aggregate limit because the local transcript stores
 * sibling results as separate user messages.
 */
function collectCandidatesByMessage(messages) {
  const groups = [];
  let current = [];
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  // Source 2.1.88/2.1.304 groups by assistant message ID, not just adjacent
  // assistant objects. The API normalizer merges fragments with the same ID
  // across interleaved assistant responses and tool-result user messages.
  // Role-based Node transcripts use sourceMessageId; object identity safely
  // separates older local assistant messages that predate this field.
  const seenAssistantMessageIds = new Set();
  for (const message of messages) {
    if (message?.role === 'user') {
      current.push(...collectCandidatesFromMessage(message));
    } else if (message?.role === 'assistant') {
      const assistantId = message.sourceMessageId ?? message.id ?? message.message?.id ?? message;
      if (!seenAssistantMessageIds.has(assistantId)) {
        flush();
        seenAssistantMessageIds.add(assistantId);
      }
    }
  }
  flush();
  return groups;
}

function buildToolNameMap(messages) {
  const map = new Map();
  for (const message of messages) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'tool_use') map.set(block.id, block.name);
    }
  }
  return map;
}

function partitionByPriorDecision(candidates, state) {
  const result = { mustReapply: [], frozen: [], fresh: [] };
  for (const candidate of candidates) {
    const replacement = state.replacements.get(candidate.toolUseId);
    if (replacement !== undefined) result.mustReapply.push({ ...candidate, replacement });
    else if (state.seenIds.has(candidate.toolUseId)) result.frozen.push(candidate);
    else result.fresh.push(candidate);
  }
  return result;
}

function selectFreshToReplace(fresh, frozenSize, limit) {
  const sorted = [...fresh].sort((a, b) => b.size - a.size);
  const selected = [];
  let remaining = frozenSize + fresh.reduce((sum, item) => sum + item.size, 0);
  for (const candidate of sorted) {
    if (remaining <= limit) break;
    selected.push(candidate);
    // Matches the source's conservative selection estimate: previews are
    // approximately 2KB, while candidates on this path are much larger.
    remaining -= candidate.size;
  }
  return selected;
}

function replaceToolResultContents(messages, replacementMap) {
  return messages.map(message => {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return message;
    const needsReplace = message.content.some(block =>
      block?.type === 'tool_result' && replacementMap.has(block.tool_use_id));
    if (!needsReplace) return message;
    return {
      ...message,
      content: message.content.map(block => {
        if (block?.type !== 'tool_result') return block;
        const replacement = replacementMap.get(block.tool_use_id);
        return replacement === undefined ? block : { ...block, content: replacement };
      }),
    };
  });
}

export function reconstructContentReplacementState(messages, records = []) {
  if (!Array.isArray(messages) || !Array.isArray(records)) {
    throw new TypeError('Content replacement reconstruction needs messages and records.');
  }
  const state = createContentReplacementState();
  const candidateIds = new Set(collectCandidatesByMessage(messages)
    .flat().map(candidate => candidate.toolUseId));
  for (const id of candidateIds) state.seenIds.add(id);
  for (const record of records) {
    if (record?.kind === 'tool-result' && candidateIds.has(record.toolUseId) &&
        typeof record.replacement === 'string') {
      state.replacements.set(record.toolUseId, record.replacement);
    }
  }
  return state;
}

export function provisionContentReplacementState(
  initialMessages,
  initialRecords = [],
  { enabled = false } = {},
) {
  if (!enabled) return undefined;
  return reconstructContentReplacementState(initialMessages ?? [], initialRecords);
}

export function getPerMessageBudgetLimit() {
  // CLI 2.1.304 uses the fixed 200K aggregate budget (gXn).
  return MAX_TOOL_RESULTS_PER_MESSAGE_CHARS;
}

/**
 * Source 2.1.88 selection/state algorithm with 2.1.304 candidate filtering,
 * exemptions, and the fixed 200K per-API-user-turn budget.
 */
export async function enforceToolResultBudget(
  messages,
  state,
  storage,
  { limit = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, skipToolNames = new Set() } = {},
) {
  if (!Array.isArray(messages) || !state ||
      !(state.seenIds instanceof Set) || !(state.replacements instanceof Map)) {
    throw new TypeError('Invalid tool-result budget input or decision state.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Tool-result aggregate budget must be a positive safe integer.');
  }
  if (!(skipToolNames instanceof Set)) skipToolNames = new Set(skipToolNames);
  const candidatesByMessage = collectCandidatesByMessage(messages);
  const nameByToolUseId = skipToolNames.size ? buildToolNameMap(messages) : undefined;
  const shouldSkip = id => nameByToolUseId !== undefined &&
    skipToolNames.has(nameByToolUseId.get(id) ?? '');
  const replacementMap = new Map();
  const toPersist = [];

  for (const candidates of candidatesByMessage) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, state);
    for (const candidate of mustReapply) {
      replacementMap.set(candidate.toolUseId, candidate.replacement);
    }
    if (!fresh.length) {
      for (const candidate of candidates) state.seenIds.add(candidate.toolUseId);
      continue;
    }
    const skipped = fresh.filter(candidate => shouldSkip(candidate.toolUseId));
    for (const candidate of skipped) state.seenIds.add(candidate.toolUseId);
    const eligible = fresh.filter(candidate => !shouldSkip(candidate.toolUseId));
    // 2.1.304 also excludes already-frozen exempt tools from the budget;
    // otherwise their old results could force unrelated new tools to offload.
    const frozenSize = frozen.reduce((sum, candidate) =>
      sum + (shouldSkip(candidate.toolUseId) ? 0 : candidate.size), 0);
    const freshSize = eligible.reduce((sum, candidate) => sum + candidate.size, 0);
    const selected = frozenSize + freshSize > limit
      ? selectFreshToReplace(eligible, frozenSize, limit) : [];
    const selectedIds = new Set(selected.map(candidate => candidate.toolUseId));
    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.toolUseId)) state.seenIds.add(candidate.toolUseId);
    }
    toPersist.push(...selected);
  }

  if (!replacementMap.size && !toPersist.length) {
    return { messages, newlyReplaced: [] };
  }
  if (toPersist.length && !storage) {
    throw new TypeError('Aggregate tool-result persistence requires session storage.');
  }
  const persisted = await Promise.all(toPersist.map(async candidate => {
    return [candidate, await persistToolResult(candidate.content, candidate.toolUseId, storage)];
  }));
  const newlyReplaced = [];
  for (const [candidate, result] of persisted) {
    // A failed persistence decision is frozen as unreplaced: the original
    // content is what the model will see, so a later turn must not change it.
    state.seenIds.add(candidate.toolUseId);
    if (isPersistError(result)) continue;
    const replacement = buildLargeToolResultMessage(result);
    replacementMap.set(candidate.toolUseId, replacement);
    state.replacements.set(candidate.toolUseId, replacement);
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement,
    });
  }
  if (!replacementMap.size) return { messages, newlyReplaced: [] };
  return {
    messages: replaceToolResultContents(messages, replacementMap),
    newlyReplaced,
  };
}

export async function applyToolResultBudget(
  messages,
  state,
  storage,
  options = {},
) {
  if (!state) return { messages, newlyReplaced: [] };
  return enforceToolResultBudget(messages, state, storage, options);
}
