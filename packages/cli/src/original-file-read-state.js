/**
 * Headless dependency closure of CLI 2.1.88:
 *   FileReadTool.call() readFileState.set(fullFilePath,{content,timestamp,offset,limit})
 *   FileEditTool.checkPermissions()/call(), FileWriteTool.checkPermissions()/call()
 *
 * The original ToolUseContext owns this Map for one active CLI process.
 * A resumed process does not assume previous read state; files must be read
 * again before an existing-file mutation. Permission and file-descriptor
 * ownership remain in the existing CLI tool adapters.
 */
export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.';

export function rememberOriginalFileRead(readFileState, fullFilePath, content, stats, {
  offset, limit,
} = {}) {
  // FileReadTool.ts:1032-1037. Preserve source fields and timestamp units.
  readFileState.set(fullFilePath, {
    content,
    timestamp: Math.floor(stats.mtimeMs),
    offset,
    limit,
    // Node inode/size checks close a Windows coarse-mtime/replacement gap.
    dev:stats.dev, ino:stats.ino, size:stats.size,
  });
}

export function checkOriginalFileReadState(readFileState, fullFilePath, fileContent, stats) {
  const lastRead = readFileState.get(fullFilePath);
  // Original FileEdit/Write checkPermissions refuses existing files not read,
  // and partial Read(offset/limit) is NOT full-file edit authorization.
  if(!lastRead || lastRead.offset !== undefined || lastRead.limit !== undefined) {
    throw new Error('File has not been read yet. Read it first before writing to it.');
  }

  // Source FileEditTool.call()/FileWriteTool.call() rechecks immediately
  // before the actual write, not only during the earlier permission step.
  // Keep source exact-content fallback for mtime-only changes (cloud sync/
  // antivirus), but deny content changes even when timestamp granularity
  // caused the timestamp to stay unchanged. A replaced inode is never the
  // same read even if bytes and mtime were copied.
  if (stats.dev !== lastRead.dev || stats.ino !== lastRead.ino ||
      fileContent !== lastRead.content) {
    throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR);
  }
}
