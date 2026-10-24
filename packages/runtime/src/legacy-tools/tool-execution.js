/**
 * Runnable Node.js port of the dispatch + stream-bridge section of
 * CLI 2.1.88 restored-src/src/services/tools/toolExecution.ts:
 * runToolUse() and streamedCheckPermissionsAndCallTool().
 *
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * Adaptation boundary: the legacy checkPermissionsAndCallTool() depends on
 * Zod tools, Pre/PostToolUse hooks, MCP and Bun flags. Until that closure is
 * executable, executeTool is the existing PR #9 validated permission runner.
 * The async generator / Stream dispatch below is the actual execution path,
 * not a disconnected reference copy.
 */
import { Stream } from './stream.js';
import { validateJsonSchema } from '../validation.js';
import { validateToolInputValues } from '../tool-registry.js';
import { processPreMappedToolResultBlock } from './tool-result-storage.js';
import { normalizeOriginalToolNewMessagesForAPI } from './original-tool-new-messages.js';

function createUserMessage(block) {
  return { role: 'user', content: Array.isArray(block) ? block : [block] };
}

function errorResult(toolUse, content) {
  return createUserMessage({
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content,
    is_error: true,
  });
}

/**
 * Same public dispatch shape as 2.1.88 runToolUse():
 * (toolUse, assistantMessage, canUseTool, toolUseContext).
 *
 * In the headless CLI adapter, canUseTool is the already-authorized
 * executeTool callback, not the unported React/Hook permission handler.
 */
export async function* runToolUse(toolUse, assistantMessage, executeTool, toolUseContext) {
  if (!toolUse || typeof toolUse.id !== 'string' || typeof toolUse.name !== 'string') {
    throw new TypeError('runToolUse requires a valid tool_use block.');
  }
  if (typeof executeTool !== 'function') {
    throw new TypeError('runToolUse requires an executable permission adapter.');
  }
  if (!toolUseContext || typeof toolUseContext.getTool !== 'function') {
    throw new TypeError('runToolUse requires the tool lookup context.');
  }

  const toolName = toolUse.name;
  const tool = toolUseContext.getTool(toolName);

  // The original runToolUse validates lookup before entering the tool
  // execution stream; preserve its tool_result error framing.
  if (!tool) {
    // The legacy framing remains here, but the host loop must still observe
    // one terminal lifecycle event for an unknown tool.
    toolUseContext.onUnknownTool?.(toolUse);
    yield {
      message: errorResult(
        toolUse,
        '<tool_use_error>Error: No such tool available: ' + toolName + '</tool_use_error>',
      ),
    };
    return;
  }

  try {
    if (toolUseContext.signal?.aborted) {
      yield {
        message: errorResult(toolUse, 'User rejected tool use'),
      };
      return;
    }

    for await (const update of streamedCheckPermissionsAndCallTool(
      tool,
      toolUse,
      assistantMessage,
      executeTool,
      toolUseContext,
    )) {
      yield update;
    }
  } catch (error) {
    if (toolUseContext.signal?.aborted) throw error;
    const details = error instanceof Error ? error.message : String(error);
    const message = 'Error calling tool (' + toolName + '): ' + details;
    yield {
      message: errorResult(
        toolUse,
        '<tool_use_error>' + message + '</tool_use_error>',
      ),
    };
  }
}

/**
 * Port of the old callback-to-Stream bridge. Progress can be sent before
 * the terminal tool_result. Worker rejection propagates into runToolUse(),
 * which converts it to the original model-visible error.
 */
export function streamedCheckPermissionsAndCallTool(
  tool,
  toolUse,
  assistantMessage,
  executeTool,
  toolUseContext,
) {
  const stream = new Stream();
  checkPermissionsAndCallTool(
    tool,
    toolUse,
    assistantMessage,
    executeTool,
    toolUseContext,
    progress => stream.enqueue({ progress }),
  )
    .then(results => {
      for (const result of results) stream.enqueue(result);
    })
    .catch(error => {
      stream.error(error);
    })
    .finally(() => {
      stream.done();
    });
  return stream;
}

/**
 * Runnable validation prefix of old checkPermissionsAndCallTool().
 * The original order is schema validation → tool-specific value validation →
 * permission/approval → call → result. The last two stages still dispatch to
 * the verified PR #9 permission executor until Bun/Hook/MCP dependencies are
 * available. Permission rewritten inputs are revalidated inside AgentLoop.
 */
async function checkPermissionsAndCallTool(
  tool,
  toolUse,
  assistantMessage,
  executeTool,
  toolUseContext,
  onToolProgress,
) {
  // From old 2.1.88 checkPermissionsAndCallTool(): schema.safeParse
  // runs first, tool.validateInput runs second; neither may request approval
  // or execute a tool on failure. Our registry stores the JSON Schema sent
  // to Messages API, so use the existing JSON Schema validator instead of
  // introducing a second Zod schema that could drift from the wire format.
  const schemaErrors = tool.inputSchema
    ? validateJsonSchema(toolUse.input, tool.inputSchema)
    : [];
  if (schemaErrors.length > 0) {
    toolUseContext.onInputValidationFailed?.({
      toolName: tool.name, toolUseId: toolUse.id, errors: schemaErrors,
    });
    return [{ message: errorResult(toolUse,
      '<tool_use_error>InputValidationError: Invalid tool input: ' +
      schemaErrors.join(' ') + '</tool_use_error>') }];
  }

  const valueErrors = await validateToolInputValues(tool, toolUse.input, toolUseContext);
  if (toolUseContext.signal?.aborted) {
    const error = toolUseContext.signal.reason instanceof Error
      ? toolUseContext.signal.reason
      : new Error('Tool execution aborted.');
    error.name = 'AbortError';
    throw error;
  }
  if (valueErrors.length > 0) {
    toolUseContext.onInputValidationFailed?.({
      toolName: tool.name, toolUseId: toolUse.id, errors: valueErrors,
    });
    return [{ message: errorResult(toolUse,
      '<tool_use_error>Invalid tool input: ' + valueErrors.join(' ') + '</tool_use_error>') }];
  }

  // PreToolUse hooks and original checkPermissionsAndCallTool authorization
  // require their stateful dependency closure; the PR #9 permission adapter
  // remains the only authority to allow a real tool call.
  const block = await executeTool(toolUse, {
    signal: toolUseContext.signal,
    onToolProgress,
    tool,
    assistantMessage,
    toolUseContext,
  });
  if (!block || block.type !== 'tool_result' || block.tool_use_id !== toolUse.id) {
    throw new Error('Tool execution adapter returned a mismatched tool_result.');
  }
  // Original checkPermissionsAndCallTool().addToolResult: first preserve the
  // authenticated tool_result, then append acceptFeedback and user-pasted
  // permission contentBlocks. The Node adapter temporarily transports those
  // blocks under an internal field; NEVER send that field to the provider.
  const { permissionContentBlocks, ...toolResultBlock } = block;
  const contentBlocks = [toolResultBlock];
  if (permissionContentBlocks !== undefined) {
    if (!Array.isArray(permissionContentBlocks) ||
        permissionContentBlocks.some(extra => !extra ||
          !['text','image'].includes(extra.type))) {
      throw new TypeError('Tool authorization returned invalid extra content blocks.');
    }
    contentBlocks.push(...permissionContentBlocks);
  }
  return [{ message: createUserMessage(contentBlocks) }];
}

/**
 * Port of the successful 2.1.88 checkPermissionsAndCallTool() tool-call and
 * result-mapping segment (original Tool.ts: call, mapper; toolExecution.ts:
 * await tool.call(...), result.data, mapToolResultToToolResultBlockParam).
 *
 * The verified AgentLoop still owns authorization and input rewrites. Only
 * after final approval does it invoke this stage with the final input.
 * The CLI does not yet support legacy additional messages, context modifiers,
 * MCP metadata or structured-output attachments: fail explicitly rather
 * than silently dropping side effects.
 */
export async function invokeToolCallAndMapResult(tool, input, {
  toolUseId, signal, messages = [], assistantMessage, onProgress,
  toolResultStorage, onToolResult, onToolAttachment, onToolNewMessages,
  userModified = false,
} = {}) {
  if (typeof toolUseId !== 'string' || !toolUseId) {
    throw new TypeError('An authenticated toolUseId is required.');
  }
  if (signal?.aborted) throw cancelledToolCall(signal);

  let mapped;
  let toolOutput;
  let structuredOutput;
  let hasStructuredOutput = false;
  let extraNativeMessages;
  let normalizedNativeMessageBlocks;
  if (typeof tool.call === 'function') {
    if (typeof tool.mapToolResultToToolResultBlockParam !== 'function') {
      throw new TypeError('Legacy tool is missing its result mapper.');
    }
    // A nested tool approval is not authorized merely because the parent
    // call has approval. Deny until legacy nested-permission routing is ported.
    const denyNestedPermission = async () => ({
      behavior: 'deny',
      reason: 'Nested permission requests are not supported by this CLI.',
    });
    const toolResult = await tool.call(
      structuredClone(input),
      { toolUseId, signal, messages: structuredClone(messages),
        // Original toolExecution.ts passes userModified on the native
        // toolUseContext to Tool.call() after explicit permission approval.
        userModified: userModified === true },
      denyNestedPermission,
      structuredClone(assistantMessage),
      onProgress,
    );
    if (signal?.aborted) throw cancelledToolCall(signal);
    if (!toolResult || typeof toolResult !== 'object' ||
      Array.isArray(toolResult) || !Object.hasOwn(toolResult, 'data')) {
      throw new TypeError('Legacy tool.call() must return { data }.');
    }
    if (toolResult.contextModifier !== undefined ||
      toolResult.mcpMeta !== undefined) {
      throw new Error('Legacy tool returned unsupported context modifier or MCP metadata.');
    }
    // Old toolExecution.ts pushes result.newMessages after PostToolUse and
    // tool_result. Source user messages flow through normalizeMessagesForAPI.
    // Validate before committing any output so invalid messages are explicit.
    if (toolResult.newMessages !== undefined) {
      normalizedNativeMessageBlocks =
        normalizeOriginalToolNewMessagesForAPI(toolResult.newMessages);
      extraNativeMessages = structuredClone(toolResult.newMessages);
    }
    // Original 2.1.88 checkPermissionsAndCallTool() ~1272: when a
    // native Tool.call() supplies structured_output, emit it as a separate
    // display/session attachment; do not turn a successful tool into error.
    hasStructuredOutput = Object.hasOwn(toolResult, 'structured_output');
    if (hasStructuredOutput) structuredOutput = toolResult.structured_output;
    toolOutput = toolResult.data;
    mapped = await tool.mapToolResultToToolResultBlockParam(toolResult.data, toolUseId);
  } else {
    if (typeof tool.execute !== 'function') {
      throw new TypeError('Registered tool has no callable implementation.');
    }
    const output = await tool.execute(structuredClone(input), {
      toolUseId, signal, messages: structuredClone(messages),
    });
    if (signal?.aborted) throw cancelledToolCall(signal);
    toolOutput = output;
    mapped = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: serializePlainToolOutput(output),
    };
  }
  if (signal?.aborted) throw cancelledToolCall(signal);
  const checked = validateMappedToolResult(mapped, toolUseId,
    typeof tool.call === 'function', Boolean(toolResultStorage));
  if (signal?.aborted) throw cancelledToolCall(signal);
  // Original toolExecution.ts uses processPreMappedToolResultBlock after
  // tool.call() has finished and the mapper has run exactly once.
  // Until the CLI supplies a session/workspace directory, keep the old
  // standalone-runtime result behavior without writing to unrelated CWDs.
  const processed = toolResultStorage
    ? await processPreMappedToolResultBlock(
        checked, tool.name, tool.maxResultSizeChars, toolResultStorage)
    : checked;
  if (signal?.aborted) throw cancelledToolCall(signal);
  // Original toolExecution.ts runs PostToolUse after mapping and saving
  // the result. An observer receives the ORIGINAL raw tool output, not
  // the on-disk preview or the API block, and cannot remap the result.
  if (onToolResult) await onToolResult({ toolOutput, mappedResult: processed });
  if (signal?.aborted) throw cancelledToolCall(signal);
  if (hasStructuredOutput) {
    // The original Query emits this attachment to its display/session
    // stream but normalizeAttachmentForAPI('structured_output') returns [].
    // Never attach it as a second tool_result or a model-visible user block.
    if (onToolAttachment) await onToolAttachment({
      type: 'structured_output', data: structuredOutput,
    });
  }
  if (signal?.aborted) throw cancelledToolCall(signal);
  // Original toolExecution.ts emits native newMessages AFTER PostToolUse
  // and structured-output attachments; the Query batches model-visible
  // text/images after the authenticated tool_result(s).
  if (onToolNewMessages && normalizedNativeMessageBlocks?.length) {
    await onToolNewMessages({
      sourceMessages: extraNativeMessages,
      blocks: normalizedNativeMessageBlocks,
    });
  }
  if (signal?.aborted) throw cancelledToolCall(signal);
  return processed;
}

function cancelledToolCall(signal) {
  const error = signal?.reason instanceof Error
    ? signal.reason : new Error('Tool execution aborted.');
  if (error.name !== 'AbortError') {
    const cancellation = new Error(error.message);
    cancellation.name = 'AbortError';
    cancellation.cause = error;
    return cancellation;
  }
  return error;
}

function serializePlainToolOutput(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new TypeError('Tool output is not JSON-serializable.');
  }
  return serialized;
}

function validateMappedToolResult(block, toolUseId, isLegacyCall, canPersist = false) {
  if (!block || typeof block !== 'object' || Array.isArray(block) ||
    block.type !== 'tool_result' || block.tool_use_id !== toolUseId) {
    throw new TypeError('Tool result mapper returned an invalid tool_result identity.');
  }
  if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
    throw new TypeError('Tool result mapper returned an invalid is_error flag.');
  }
  const content = block.content ?? '';
  if (typeof content !== 'string' && !Array.isArray(content)) {
    throw new TypeError('Tool result mapper returned unsupported content.');
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new TypeError('Tool result mapper returned a malformed content block.');
      }
      if (item.type === 'text') {
        if (typeof item.text !== 'string') {
          throw new TypeError('Tool result mapper returned invalid text content.');
        }
      } else if (item.type === 'image') {
        if (item.source?.type !== 'base64' ||
          !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(item.source.media_type) ||
          typeof item.source.data !== 'string' ||
          item.source.data.length === 0 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.source.data)) {
          throw new TypeError('Tool result mapper returned invalid image content.');
        }
      } else {
        throw new TypeError('Tool result mapper returned an unsupported content block type.');
      }
    }
  }
  const serialized = typeof content === 'string' ? content : JSON.stringify(content);
  if (isLegacyCall && !canPersist &&
    (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 1024 * 1024)) {
    // Original 2.1.88 spills large result contents to session storage.
    // That persistence dependency is unported, so refuse oversized blocks.
    throw new RangeError('Tool result exceeds the 1 MiB mapping limit.');
  }
  // Keep the result shape constrained to the model-facing API fields. Do not
  // forward internal metadata a tool might accidentally or maliciously emit.
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    ...(block.is_error === true ? { is_error: true } : {}),
  };
}
