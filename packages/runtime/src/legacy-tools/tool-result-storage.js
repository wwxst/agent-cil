/**
 * Direct Node port of CLI 2.1.88 utils/toolResultStorage.ts.
 * Original TS is preserved verbatim under legacy-original/.
 * Changes are limited to Node storage context, path safety and absent
 * telemetry/feature-gate dependencies.
 */
import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

export const TOOL_RESULTS_SUBDIR = 'tool-results';
export const PERSISTED_OUTPUT_TAG = '<persisted-output>';
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]';
export const PREVIEW_SIZE_BYTES = 2000;
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;
export const MAX_TOOL_RESULT_BYTES = 400_000;
export const BYTES_PER_TOKEN = 4;

export function getPersistenceThreshold(toolName, declaredMaxResultSizeChars = DEFAULT_MAX_RESULT_SIZE_CHARS) {
  if (!Number.isFinite(declaredMaxResultSizeChars)) return declaredMaxResultSizeChars;
  // Original GrowthBook override is unavailable to the local Node CLI.
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS);
}

function assertStorageContext(storage) {
  if (!storage || typeof storage.directory !== 'string' || typeof storage.workspace !== 'string') {
    throw new TypeError('Tool result persistence requires a workspace and directory.');
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
async function ensureNoSymlink(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symlink not permitted for persisted tool result: ' + path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
export async function ensureToolResultsDir(storage) {
  const root = await realpath(assertStorageContext(storage).workspace);
  const directory = getToolResultsDir(storage);
  const rel = relative(root, directory);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !rel) {
    throw new Error('Tool results directory must be inside the workspace.');
  }
  let current = root;
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
  if (isJson && content.some(block => block.type !== 'text')) {
    return { error: 'Cannot persist tool results containing non-text content' };
  }
  await ensureToolResultsDir(storage);
  const filepath = getToolResultPath(toolUseId, isJson, storage);
  const contentStr = isJson ? JSON.stringify(content, null, 2) : content;
  try {
    await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const previewInfo = generatePreview(contentStr, PREVIEW_SIZE_BYTES);
  return { filepath, originalSize: contentStr.length, isJson, ...previewInfo };
}

export function buildLargeToolResultMessage(result) {
  const formatFileSize = bytes => bytes < 1024 ? bytes + ' B' :
    bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' :
    (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  let message = PERSISTED_OUTPUT_TAG + '\n';
  message += 'Output too large (' + formatFileSize(result.originalSize) +
    '). Full output saved to: ' + result.filepath + '\n\n';
  message += 'Preview (first ' + formatFileSize(PREVIEW_SIZE_BYTES) + '):\n';
  message += result.preview;
  message += result.hasMore ? '\n...\n' : '\n';
  message += PERSISTED_OUTPUT_CLOSING_TAG;
  return message;
}

export async function processToolResultBlock(tool, toolUseResult, toolUseID, storage) {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(toolUseResult, toolUseID);
  return maybePersistLargeToolResult(toolResultBlock, tool.name,
    getPersistenceThreshold(tool.name, tool.maxResultSizeChars), storage);
}
export async function processPreMappedToolResultBlock(toolResultBlock, toolName, maxResultSizeChars, storage) {
  return maybePersistLargeToolResult(toolResultBlock, toolName,
    getPersistenceThreshold(toolName, maxResultSizeChars), storage);
}
export function isToolResultContentEmpty(content) {
  if (!content) return true;
  if (typeof content === 'string') return content.trim() === '';
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.every(block => typeof block === 'object' && 'type' in block &&
    block.type === 'text' && 'text' in block &&
    (typeof block.text !== 'string' || block.text.trim() === ''));
}
function hasImageBlock(content) {
  return Array.isArray(content) &&
    content.some(block => typeof block === 'object' && 'type' in block &&
      block.type === 'image');
}
function contentSize(content) {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, block) =>
    sum + (block.type === 'text' ? block.text.length : 0), 0);
}
async function maybePersistLargeToolResult(toolResultBlock, toolName, persistenceThreshold, storage) {
  const content = toolResultBlock.content;
  if (isToolResultContentEmpty(content)) {
    return { ...toolResultBlock, content: '(' + toolName + ' completed with no output)' };
  }
  if (!content) return toolResultBlock;
  if (hasImageBlock(content)) return toolResultBlock;
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
