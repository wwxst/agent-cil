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

function createUserMessage(block) {
  return { role: 'user', content: [block] };
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
  });
  if (!block || block.type !== 'tool_result' || block.tool_use_id !== toolUse.id) {
    throw new Error('Tool execution adapter returned a mismatched tool_result.');
  }
  return [{ message: createUserMessage(block) }];
}
