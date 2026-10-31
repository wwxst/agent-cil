/** Preserve the original 2.1.88/2.1.304 tool progress Message envelope. */
export function createProgressMessage({ toolUseID, parentToolUseID, data }) {
  return {
    type: 'progress',
    toolUseID,
    parentToolUseID,
    data,
  };
}

/** Normalize legacy tool.call callbacks and already-wrapped progress messages. */
export function normalizeToolProgress(progress, parentToolUseID) {
  const value = progress && typeof progress === 'object'
    ? progress
    : { data: progress };
  const toolUseID = typeof value.toolUseID === 'string'
    ? value.toolUseID
    : parentToolUseID;
  const data = Object.prototype.hasOwnProperty.call(value, 'data')
    ? value.data
    : value;

  if (
    value.type === 'progress' &&
    value.parentToolUseID === parentToolUseID &&
    typeof value.toolUseID === 'string' &&
    Object.prototype.hasOwnProperty.call(value, 'data')
  ) {
    return value;
  }

  return createProgressMessage({ toolUseID, parentToolUseID, data });
}
