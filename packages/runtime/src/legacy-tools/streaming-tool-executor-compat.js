/** Platform seams for the directly ported CLI 2.1.88 StreamingToolExecutor.
 * The original scheduler and queue/state transitions live in the core file. */
import { setMaxListeners } from 'node:events';

export const BASH_TOOL_NAME = 'Bash';
export const REJECT_MESSAGE = 'User rejected tool use';
export const withMemoryCorrectionHint = message => message;
export const createUserMessage = ({ content }) => ({ type: 'user', message: { content } });
export const findToolByName = (definitions, name) => definitions.get(name);

/** Direct port of restored-src/src/utils/abortController.ts child cleanup. */
export function createChildAbortController(parent, maxListeners = 50) {
  const child = new AbortController();
  setMaxListeners(maxListeners, child.signal);
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }
  const weakChild = new WeakRef(child);
  const weakParent = new WeakRef(parent);
  const handler = () => weakChild.deref()?.abort(weakParent.deref()?.signal.reason);
  parent.signal.addEventListener('abort', handler, { once: true });
  child.signal.addEventListener('abort', () => {
    weakParent.deref()?.signal.removeEventListener('abort', handler);
  }, { once: true });
  return child;
}

/** Node Query already performs the real runToolUse validation/permission/call
 * chain. Convert only its message envelope into the original Message union. */
export async function* runToolUse(block, assistantMessage, canUseTool, context) {
  try {
    // Native source StreamingToolExecutor has already applied any prior
    // exclusive tool contextModifier to this context. Do not rebuild a
    // baseline ToolUseContext for every next tool; pass its current state.
    const source = context.executeAdapter(block, {
      signal: context.abortController.signal,
      toolUseContext: context,
    });
    const iterator = source && typeof source[Symbol.asyncIterator] === 'function'
      ? source
      : (async function* () {
          yield { message: { role: 'user', content: [await source] } };
        })();
    for await (const update of iterator) {
      if (update?.progress !== undefined) {
        yield { message: { type: 'progress', progress: update.progress } };
      }
      if (update?.message) {
        // Original runToolUse emits contextModifier ON THE SAME MessageUpdate
        // as the tool_result. Do not split into a message-less update:
        // the transplanted scheduler inspects update.message.type.
        yield {
          message: { type: 'user', message: update.message },
          ...(update.contextModifier ? { contextModifier: update.contextModifier } : {}),
        };
      } else if (update?.contextModifier) {
        throw new TypeError('Original contextModifier requires a tool result message.');
      }
    }
  } catch (error) {
    yield { message: createUserMessage({ content: [{
      type: 'tool_result', tool_use_id: block.id, is_error: true,
      content: '<tool_use_error>' +
        (error instanceof Error ? error.message : String(error)) +
        '</tool_use_error>',
    }] }) };
  }
}
