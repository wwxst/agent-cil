/** Node-only interface adapter over the actual 2.1.88 StreamingToolExecutor.
 * Scheduling, abort classification, sibling cancellation, modifiers and
 * tool statuses are owned by the transpiled original implementation. */
import { StreamingToolExecutor as OriginalStreamingToolExecutor } from './streaming-tool-executor-core.js';
import { validateJsonSchema } from '../validation.js';

export class StreamingToolExecutor extends OriginalStreamingToolExecutor {
  #abortController;
  #detachAbort;
  #getTool;
  #onUnknownTool;
  #drainGeneration = 0;
  #drainableResolve;
  constructor({ execute, getTool, signal, onUnknownTool, initialContext } = {}) {
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
    // Original query.ts carries the updated ToolUseContext across model
    // rounds. Reuse its tool-owned state while rebuilding current-round
    // security/lifecycle adapters (never reuse an earlier abort controller,
    // execution dispatcher or completion bookkeeping).
    if (initialContext !== undefined &&
        (!initialContext || typeof initialContext !== 'object' ||
         Array.isArray(initialContext))) {
      throw new TypeError('Original updated ToolUseContext must be an object.');
    }
    const toolUseContext = {
      ...(initialContext || {}),
      abortController,
      executeAdapter: (block, context) => {
        // A queued tool must not begin after an interrupt even if an earlier
        // non-cancellable tool held the parent signal open.
        if (signal?.aborted && !abortController.signal.aborted) {
          throw new Error('Interrupted before queued tool execution.');
        }
        // The source core's this.toolUseContext changes after each
        // non-concurrent tool modifier; forward that exact context. Drain
        // wakeups are emitted by the original scheduler after it has queued
        // a heartbeat or completed the tool, not by this transport adapter.
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
    this.#getTool = getTool;
    this.#onUnknownTool = onUnknownTool;
    this.#detachAbort = () => signal?.removeEventListener('abort', onAbort);
  }
  get drainGeneration() {
    return this.#drainGeneration;
  }
  waitForDrainable(generation) {
    if (this.#drainGeneration > generation) {
      return Promise.resolve(this.#drainGeneration);
    }
    return new Promise(resolve => {
      this.#drainableResolve = () => resolve(this.#drainGeneration);
    });
  }
  #wakeDrainable() {
    this.#drainGeneration += 1;
    const resolve = this.#drainableResolve;
    this.#drainableResolve = undefined;
    resolve?.(this.#drainGeneration);
  }
  onDrainableAvailable() {
    // Original 2.1.304 wakeWaiters() wakes both the stream drain and a
    // post-stream getRemainingResults() waiter.
    this.#wakeDrainable();
    if (this.progressAvailableResolve) {
      const resolve = this.progressAvailableResolve;
      this.progressAvailableResolve = undefined;
      resolve();
    }
  }
  cancelDrainWait() {
    const resolve = this.#drainableResolve;
    this.#drainableResolve = undefined;
    resolve?.(this.#drainGeneration);
  }
  *getPendingProgress() {
    // 2.1.304 drains heartbeat progress while the model stream is open and
    // ordinary progress when a tool completes. Keep tool_result blocks queued
    // until message_end is validated and the durable checkpoint is written.
    for (const tool of this.tools) {
      while (tool.pendingProgress?.length) {
        const message = tool.pendingProgress.shift();
        // Keep the original ProgressMessage envelope. AgentLoop consumers need
        // toolUseID, parentToolUseID and data; unwrapping data changes the event contract.
        yield { progress: message };
      }
    }
  }
  discard() {
    super.discard();
    // The source's discard() tombstones results; Node stream fallback must
    // also abort speculative Read/Search tasks to release file descriptors.
    this.#abortController.abort('streaming_fallback');
    this.#detachAbort();
    this.onDrainableAvailable();
  }
  async awaitInFlightCleanup() {
    // Original StreamingToolExecutor owns every started generator promise.
    // Node Query can discard an incomplete model stream while speculative
    // Read/Glob/Grep is still unwinding its AbortSignal and closing file
    // descriptors. Merely setting discarded=true tombstones its results; it
    // does NOT mean its existing async execution has finished. Join those
    // same original promises instead of creating a second tool scheduler.
    // Query must not begin another prompt or release the session lock before
    // all already-started execution has actually settled.
    const running=this.tools.filter(tool =>
      tool.status==='executing' && tool.promise);
    await Promise.allSettled(running.map(tool=>tool.promise));
  }
  addTool(block) {
    // Original addTool() handles unknown tools before runToolUse. Preserve
    // Query's existing completion event on this adapter seam.
    const unknown = !this.#getTool(block.name);
    if (unknown) this.#onUnknownTool?.(block);
    const result = super.addTool(block, { uuid: block.id });
    if (unknown) this.onDrainableAvailable();
    return result;
  }
  *getCompletedResults() {
    for (const update of super.getCompletedResults()) {
      if (update.message?.type === 'progress') {
        // Match getPendingProgress() and the original 2.1.88 ProgressMessage:
        // retain type, toolUseID, parentToolUseID and data through the event API.
        yield { progress: update.message };
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
      this.cancelDrainWait();
      this.#detachAbort();
    }
  }
}
