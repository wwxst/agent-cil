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

function neverInvokedResult(id) {
  return { role: 'user', content: [{
    type: 'tool_result', tool_use_id: id, is_error: true,
    content: '<tool_use_error>Interrupted: tool was not started; no tool execution was attempted.</tool_use_error>',
  }] };
}

function uncertainSideEffectResult(id) {
  return { role: 'user', content: [{
    type: 'tool_result', tool_use_id: id, is_error: true,
    content: '<tool_use_error>Interrupted: tool call started; side effects may have occurred. Inspect files/processes before retry. Do not automatically replay.</tool_use_error>',
  }] };
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
    // Wake the result consumer if cancellation arrived while awaiting a
    // pending worker. Query can then record an interrupted checkpoint.
    signal?.addEventListener('abort', () => this.#notifyProgress(), { once: true });
  }

  discard() {
    if (this.#discarded) return;
    this.#discarded = true;
    // In 2.1.88 streaming_fallback tombstones pending tool results. In this
    // Node port, a failed model stream must additionally cancel any in-flight
    // read-only operation. No orphan result may reach the next conversation.
    if (!this.#siblingController.signal.aborted) {
      this.#siblingController.abort('streaming_fallback');
    }
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
    if (this.#signal?.aborted) {
      // Original 2.1.88 executor yields synthetic tool_results for queued
      // tools after interruption, but never executes them.
      for (const tool of this.#tools) {
        if (tool.status !== 'queued') continue;
        tool.wasQueuedWhenCancelled = true;
        tool.results = [syntheticError(tool.id, 'user_interrupted')];
        tool.status = 'completed';
      }
      this.#notifyProgress();
      return;
    }
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
        tool.results = [initialReason === 'user_interrupted' &&
          this.#signal?.reason !== 'interrupt'
          ? neverInvokedResult(tool.id)
          : syntheticError(tool.id, initialReason, this.#erroredToolDescription)];
        tool.status = 'completed';
        return;
      }
      let selfErrored = false;
      try {
        // Admission/permission checks are not a side effect. Only the
        // validated tool.call()/execute() boundary marks a real invocation.
        const source = this.#execute(tool.block, {
          signal: controller.signal,
          onToolExecutionStarted: () => { tool.callStarted = true; },
        });
        // runToolUse in 2.1.88 yields messages; the active AgentLoop adapter
        // returns its existing validated tool_result via a Promise.
        const iterator = source && typeof source[Symbol.asyncIterator] === 'function'
          ? source
          : (async function* () { yield { message: { role: 'user', content: [await source] } }; })();
        for await (const update of iterator) {
          const reason = this.#abortReason(tool);
          if (reason && !selfErrored) {
            // Preserve the old explicit 'interrupt' contract for tools
            // opting into cancellation. New AbortError flow distinguishes
            // already-returned results from side effects still uncertain.
            messages.push(this.#signal?.reason === 'interrupt'
              ? syntheticError(tool.id, reason, this.#erroredToolDescription)
              : update?.message || (tool.callStarted
                ? uncertainSideEffectResult(tool.id)
                : syntheticError(tool.id, reason, this.#erroredToolDescription)));
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
        messages.push(reason === 'user_interrupted' &&
          this.#signal?.reason !== 'interrupt'
          ? (tool.callStarted
            ? uncertainSideEffectResult(tool.id)
            : neverInvokedResult(tool.id))
          : syntheticError(tool.id, reason || 'sibling_error', this.#erroredToolDescription));
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

  /**
   * 2.1.88 query.ts drains completed and missing tool_result blocks when
   * aborted; CLI 2.1.304 StreamingToolExecutor.takeFinishedResults() and
   * discardAndAbortInFlight distinguish completed vs call-started vs queued.
   * Adapt those same states for a single Node assistant message: preserve the
   * actual result for completed tools, synthesize never-started results for
   * queued tools and mark unresolved in-flight side effects as UNCERTAIN.
   * Results remain in model tool_use order with exactly one tool_result/id.
   */
  async takeInterruptedResults({ settleTimeoutMs = 1500 } = {}) {
    if (!this.#signal?.aborted) {
      throw new TypeError('Interrupted results require an aborted signal.');
    }
    // Propagate cancellation to all workers; the Bash tool propagates this
    // to the OS process tree. Never wait forever for uncooperative tools.
    if (!this.#siblingController.signal.aborted) {
      this.#siblingController.abort('user_interrupted');
    }
    const running = this.#tools
      .filter(t => t.status === 'executing' && t.promise)
      .map(t => t.promise);
    if (running.length) {
      let timer;
      try {
        await Promise.race([
          Promise.allSettled(running),
          new Promise(resolve => { timer = setTimeout(resolve, settleTimeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    const results = this.#tools.map(tool => {
      if (tool.wasQueuedWhenCancelled) {
        return {
          type: 'tool_result', tool_use_id: tool.id, is_error: true,
          content: '<tool_use_error>Interrupted: tool was not started; no tool execution was attempted.</tool_use_error>',
        };
      }
      const blocks = tool.status === 'completed' || tool.status === 'yielded'
        ? tool.results?.flatMap(m =>
          m?.role === 'user' && Array.isArray(m.content)
            ? m.content.filter(b => b?.type === 'tool_result' && b.tool_use_id === tool.id)
            : []) ?? []
        : [];
      if (blocks.length === 1) return structuredClone(blocks[0]);
      const maybeExecuted = tool.callStarted === true;
      return {
        type: 'tool_result', tool_use_id: tool.id, is_error: true,
        content: maybeExecuted
          ? '<tool_use_error>Interrupted: tool was started; side effects may have occurred or the result may have completed. Inspect the workspace before retrying; do not automatically replay this call.</tool_use_error>'
          : '<tool_use_error>Interrupted: tool was not started; no tool execution was attempted.</tool_use_error>',
      };
    });
    this.discard();
    return results;
  }

  #hasExecutingTools() { return this.#tools.some(t => t.status === 'executing'); }
  #hasUnfinishedTools() { return this.#tools.some(t => t.status !== 'yielded'); }

  async *getRemainingResults() {
    if (this.#discarded) return;
    // A user abort must also wake the result consumer itself. Waiting only
    // on tool.promise can hang forever if a third-party tool ignores its
    // AbortSignal; Query needs to reach takeInterruptedResults() and create
    // bounded, explicitly-uncertain tool_result blocks instead.
    const wakeOnAbort = () => this.#notifyProgress();
    this.#signal?.addEventListener('abort', wakeOnAbort, { once: true });
    try {
    while (!this.#discarded && this.#hasUnfinishedTools()) {
      this.#processQueue();
      let producedUpdate = false;
      for (const update of this.getCompletedResults()) {
        producedUpdate = true;
        yield update;
      }
      if (this.#discarded) return;
      // In an AbortError-based CLI cancellation, do not wait indefinitely
      // for a hostile tool; Query uses takeInterruptedResults() with a bounded
      // settle deadline. The explicit legacy 'interrupt' reason preserves
      // the older blocking-tool contract.
      if (this.#signal?.aborted && this.#signal.reason !== 'interrupt') return;
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
    } finally {
      this.#signal?.removeEventListener('abort', wakeOnAbort);
    }
  }
}
