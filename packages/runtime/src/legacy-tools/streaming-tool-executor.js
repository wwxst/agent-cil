/** Node-only interface adapter over the actual 2.1.88 StreamingToolExecutor.
 * Scheduling, abort classification, sibling cancellation, modifiers and
 * tool statuses are owned by the transpiled original implementation. */
import { StreamingToolExecutor as OriginalStreamingToolExecutor } from './streaming-tool-executor-core.js';
import { validateJsonSchema } from '../validation.js';

export class StreamingToolExecutor extends OriginalStreamingToolExecutor {
  #abortController;
  #detachAbort;
  constructor({ execute, getTool, signal } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
    if (typeof getTool !== 'function') throw new TypeError('getTool must be a function.');
    const abortController = new AbortController();
    let instance;
    const onAbort = () => {
      // Old Query never signals an interrupt-blocking tool. Our Node CLI
      // receives a single external signal, so preserve the active tool until
      // it completes (2.1.304 also differentiates blocking/cancellable tools).
      if (signal?.reason === 'interrupt' && instance?.tools.some(t =>
        t.status === 'executing' &&
        instance.getToolInterruptBehavior(t) === 'block')) return;
      abortController.abort(signal?.reason);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const inProgress = new Set();
    const toolUseContext = {
      abortController,
      executeAdapter: (block, context) => {
        // A queued tool must not begin after an interrupt even if an earlier
        // non-cancellable tool held the parent signal open.
        if (signal?.aborted && !abortController.signal.aborted) {
          throw new Error('Interrupted before queued tool execution.');
        }
        return execute(block, context);
      },
      // Preserve the original first-writer API: each state update receives
      // an immutable Set copy and returns its replacement.
      setInProgressToolUseIDs: update => {
        const next = update(new Set(inProgress));
        inProgress.clear();
        for (const id of next) inProgress.add(id);
      },
      setHasInterruptibleToolInProgress: () => {},
      strictOrderedResults: true,
    };
    const toolDefinitions = { get: name => {
      const tool = getTool(name);
      if (!tool) return undefined;
      return {
        inputSchema: { safeParse: input => {
          try {
            const errors = tool.inputSchema ? validateJsonSchema(input, tool.inputSchema) : [];
            return errors.length ? { success: false, error: errors } : { success: true, data: input };
          } catch { return { success: false }; }
        } },
        isConcurrencySafe: tool.isConcurrencySafe || (() => false),
        interruptBehavior: tool.interruptBehavior,
      };
    } };
    super(toolDefinitions, undefined, toolUseContext);
    instance = this;
    this.#abortController = abortController;
    this.#detachAbort = () => signal?.removeEventListener('abort', onAbort);
  }
  discard() {
    super.discard();
    // The source's discard() tombstones results; Node stream fallback must
    // also abort speculative Read/Search tasks to release file descriptors.
    this.#abortController.abort('streaming_fallback');
    this.#detachAbort();
  }
  addTool(block) {
    // The CLI emits one whole assistant turn; legacy executor accepts the
    // assistant's per-content message envelope only for result attribution.
    return super.addTool(block, { uuid: block.id });
  }
  *getCompletedResults() {
    for (const update of super.getCompletedResults()) {
      if (update.message?.type === 'progress') {
        yield { progress: update.message.progress };
      } else if (update.message?.type === 'user') {
        yield { message: update.message.message };
      }
    }
  }
  async *getRemainingResults() {
    try {
      // Original getRemainingResults() dispatches via this.getCompletedResults.
      yield* super.getRemainingResults();
    } finally {
      this.#detachAbort();
    }
  }
}
