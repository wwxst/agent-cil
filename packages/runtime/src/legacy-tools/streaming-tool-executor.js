/**
 * Node.js port of CLI 2.1.88
 * restored-src/src/services/tools/StreamingToolExecutor.ts.
 *
 * Retains the original queue states, exclusive/concurrency-safe admission,
 * ordered-exclusive delivery, immediate progress, discard and sibling-error
 * cancellation. The original ToolUseContext, Zod and runToolUse() imports
 * terminate in a small callback adapter until toolExecution.ts is compiled.
 *
 * Original notice: © Anthropic PBC. All rights reserved.
 * No UI, Bun runtime or Desktop dependency.
 */
function syntheticError(id, reason, bashDescription = '') {
  const content = reason === 'streaming_fallback'
    ? '<tool_use_error>Error: Streaming fallback - tool execution discarded</tool_use_error>'
    : reason === 'user_interrupted'
      ? 'User rejected tool use'
      : '<tool_use_error>' +
        (bashDescription
          ? 'Cancelled: parallel tool call ' + bashDescription + ' errored'
          : 'Cancelled: parallel tool call errored') + '</tool_use_error>';
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: true }] };
}

function toolNameDescription(block) {
  const summary = block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? '';
  const text = typeof summary === 'string' ? summary : '';
  return text ? block.name + '(' + (text.length > 40 ? text.slice(0, 40) + '…' : text) + ')' : block.name;
}

function linkedController(signal) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

export class StreamingToolExecutor {
  #tools = [];
  #execute;
  #getTool;
  #signal;
  #siblingController;
  #hasErrored = false;
  #erroredToolDescription = '';
  #discarded = false;
  #progressAvailableResolve;

  /**
   * execute(block, { signal }) -> async iterable of {message} and/or
   * {progress}, or a Promise resolving to a tool_result block.
   * getTool(name) -> { isConcurrencySafe(input), interruptBehavior() }.
   * On the active CLI path execute delegates to the verified PR #9
   * permission+input-validation+tool executor without bypassing it.
   */
  constructor({ execute, getTool, signal } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
    if (typeof getTool !== 'function') throw new TypeError('getTool must be a function.');
    this.#execute = execute;
    this.#getTool = getTool;
    this.#signal = signal;
    this.#siblingController = new AbortController();
  }

  discard() {
    this.#discarded = true;
    this.#notifyProgress();
  }

  #notifyProgress() {
    if (this.#progressAvailableResolve) {
      const resolve = this.#progressAvailableResolve;
      this.#progressAvailableResolve = undefined;
      resolve();
    }
  }

  addTool(block) {
    if (this.#discarded) return;
    if (!block || typeof block.id !== 'string' || typeof block.name !== 'string') {
      throw new TypeError('Tool block must contain a tool id and name.');
    }
    const definition = this.#getTool(block.name);
    let isConcurrencySafe = false;
    if (definition && typeof definition.isConcurrencySafe === 'function') {
      try {
        isConcurrencySafe = Boolean(definition.isConcurrencySafe(block.input));
      } catch {
        isConcurrencySafe = false;
      }
    }
    this.#tools.push({
      id: block.id,
      block,
      status: 'queued',
      isConcurrencySafe,
      interruptBehavior: definition?.interruptBehavior,
      pendingProgress: [],
    });
    this.#processQueue();
  }

  #canExecuteTool(isConcurrencySafe) {
    const executing = this.#tools.filter(t => t.status === 'executing');
    return executing.length === 0 ||
      (isConcurrencySafe && executing.every(t => t.isConcurrencySafe));
  }

  // Original queue traversal: a queued exclusive tool is a barrier. Safe
  // tools may execute concurrently only when no exclusive tool is running.
  #processQueue() {
    if (this.#discarded) return;
    for (const tool of this.#tools) {
      if (tool.status !== 'queued') continue;
      if (this.#canExecuteTool(tool.isConcurrencySafe)) {
        this.#executeTool(tool);
      } else if (!tool.isConcurrencySafe) {
        break;
      }
    }
  }

  #getInterruptBehavior(tool) {
    if (typeof tool.interruptBehavior !== 'function') return 'block';
    try { return tool.interruptBehavior() === 'cancel' ? 'cancel' : 'block'; }
    catch { return 'block'; }
  }

  #abortReason(tool) {
    if (this.#discarded) return 'streaming_fallback';
    if (this.#hasErrored) return 'sibling_error';
    if (this.#signal?.aborted) {
      if (this.#signal.reason === 'interrupt') {
        return this.#getInterruptBehavior(tool) === 'cancel'
          ? 'user_interrupted' : null;
      }
      return 'user_interrupted';
    }
    return null;
  }

  #executeTool(tool) {
    tool.status = 'executing';
    const controller = linkedController(this.#siblingController.signal);
    // A user interrupt may be blocked by this tool. Forward other aborts,
    // including sibling errors, but do not pre-abort interrupt-blocking tools.
    const onParentAbort = () => {
      if (this.#signal?.reason !== 'interrupt' || this.#getInterruptBehavior(tool) === 'cancel') {
        controller.abort(this.#signal?.reason);
      }
    };
    if (this.#signal) {
      if (this.#signal.aborted) onParentAbort();
      else this.#signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const collect = async () => {
      const messages = [];
      const initialReason = this.#abortReason(tool);
      if (initialReason) {
        tool.results = [syntheticError(tool.id, initialReason, this.#erroredToolDescription)];
        tool.status = 'completed';
        return;
      }
      let selfErrored = false;
      try {
        const source = this.#execute(tool.block, { signal: controller.signal });
        // runToolUse in 2.1.88 yields messages; the active AgentLoop adapter
        // returns its existing validated tool_result via a Promise.
        const iterator = source && typeof source[Symbol.asyncIterator] === 'function'
          ? source
          : (async function* () { yield { message: { role: 'user', content: [await source] } }; })();
        for await (const update of iterator) {
          const reason = this.#abortReason(tool);
          if (reason && !selfErrored) {
            messages.push(syntheticError(tool.id, reason, this.#erroredToolDescription));
            break;
          }
          if (update?.progress !== undefined) {
            tool.pendingProgress.push(update.progress);
            this.#notifyProgress();
          }
          if (update?.message) {
            messages.push(update.message);
            const isError = update.message.role === 'user' &&
              Array.isArray(update.message.content) &&
              update.message.content.some(block =>
                block.type === 'tool_result' && block.is_error === true);
            if (isError) {
              selfErrored = true;
              if (tool.block.name === 'Bash') {
                this.#hasErrored = true;
                this.#erroredToolDescription = toolNameDescription(tool.block);
                this.#siblingController.abort('sibling_error');
              }
            }
          }
        }
      } catch (error) {
        const reason = this.#abortReason(tool);
        messages.push(syntheticError(tool.id, reason || 'sibling_error', this.#erroredToolDescription));
      }
      tool.results = messages;
      tool.status = 'completed';
    };
    // Convert all worker failures to finished tool results and never create
    // an unhandled rejection from the completion continuation.
    tool.promise = collect().catch(() => {
      tool.results = [syntheticError(tool.id, 'sibling_error', this.#erroredToolDescription)];
      tool.status = 'completed';
    }).finally(() => {
      this.#signal?.removeEventListener('abort', onParentAbort);
      this.#processQueue();
      this.#notifyProgress();
    });
  }

  *getCompletedResults() {
    if (this.#discarded) return;
    let waitingOnEarlierResult = false;
    for (const tool of this.#tools) {
      // Progress may arrive from later safe tools immediately, but their final
      // results must retain the model's original tool_use order.
      while (tool.pendingProgress.length > 0) {
        yield { progress: tool.pendingProgress.shift() };
      }
      if (tool.status === 'yielded') continue;
      if (tool.status === 'completed' && tool.results && !waitingOnEarlierResult) {
        tool.status = 'yielded';
        for (const message of tool.results) yield { message };
      } else {
        waitingOnEarlierResult = true;
      }
    }
  }

  #hasExecutingTools() { return this.#tools.some(t => t.status === 'executing'); }
  #hasUnfinishedTools() { return this.#tools.some(t => t.status !== 'yielded'); }

  async *getRemainingResults() {
    if (this.#discarded) return;
    while (!this.#discarded && this.#hasUnfinishedTools()) {
      this.#processQueue();
      let producedUpdate = false;
      for (const update of this.getCompletedResults()) {
        producedUpdate = true;
        yield update;
      }
      if (this.#discarded) return;
      // A later safe tool can already be completed but blocked on an earlier
      // result. Await the unfinished worker rather than spinning synchronously.
      if (this.#hasExecutingTools() && !producedUpdate) {
        const promises = this.#tools
          .filter(t => t.status === 'executing' && t.promise)
          .map(t => t.promise);
        if (promises.length > 0) {
          let resolveProgress;
          const progress = new Promise(resolve => { resolveProgress = resolve; });
          this.#progressAvailableResolve = resolveProgress;
          try { await Promise.race([...promises, progress]); }
          finally {
            if (this.#progressAvailableResolve === resolveProgress) {
              this.#progressAvailableResolve = undefined;
            }
          }
        }
      }
    }
    if (!this.#discarded) {
      for (const update of this.getCompletedResults()) yield update;
    }
  }
}
