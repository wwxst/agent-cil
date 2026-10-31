/**
 * Executable transcription of original CLI 2.1.88 toolExecution.ts
 * checkPermissionsAndCallTool() input-observation/call split
 * (~765–790, ~1175–1210 in legacy-original/toolExecution.ts).
 *
 * Keep original variable names: processedInput is observable to Hooks and
 * permission checks, while callInput preserves the model's original input.
 * Only an intentional permission/Hook updatedInput can change tool.call().
 * Do not mutate the model's tool_use transcript or tool.call input through
 * backfillObservableInput().
 */
export function prepareObservableToolInput(tool, parsedInput) {
  let processedInput = parsedInput;
  let callInput = processedInput;
  const backfilledClone =
    tool.backfillObservableInput &&
    typeof processedInput === 'object' &&
    processedInput !== null
      ? { ...processedInput }
      : null;
  if (backfilledClone) {
    tool.backfillObservableInput(backfilledClone);
    processedInput = backfilledClone;
  }
  return { processedInput, callInput, backfilledClone };
}

/**
 * Source-equivalent last step before await tool.call(...):
 * restore the unexpanded model file_path when a permission result merely
 * echoed the observation-only expansion, but honor any other Hook input
 * replacements that were explicitly supplied.
 */
export function restoreToolCallInput(processedInput, callInput, backfilledClone) {
  if (
    backfilledClone &&
    processedInput !== callInput &&
    typeof processedInput === 'object' &&
    processedInput !== null &&
    'file_path' in processedInput &&
    'file_path' in callInput &&
    processedInput.file_path === backfilledClone.file_path
  ) {
    callInput = { ...processedInput, file_path: callInput.file_path };
  } else if (processedInput !== backfilledClone) {
    callInput = processedInput;
  }
  return callInput;
}
