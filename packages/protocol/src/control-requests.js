/** Error returned by the peer for a control_request. */
export class ControlRequestError extends Error {
  constructor(message, { requestId, errorCode, response } = {}) {
    super(message);
    this.name = 'ControlRequestError';
    this.requestId = requestId;
    this.errorCode = errorCode;
    this.response = response;
  }
}

export class ControlRequestTimeoutError extends Error {
  constructor(requestId, timeoutMs) {
    super(`Control request ${requestId} timed out after ${timeoutMs} ms.`);
    this.name = 'ControlRequestTimeoutError';
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

export class ControlRequestRegistryClosedError extends Error {
  constructor() {
    super('The control request registry is closed.');
    this.name = 'ControlRequestRegistryClosedError';
  }
}

function createAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The control request was aborted.');
  error.name = 'AbortError';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function readResponseId(frame) {
  if (frame?.type !== 'control_response') return undefined;
  const id = frame.response?.request_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Correlates control_request responses by request_id rather than arrival order.
 * A small bounded orphan cache handles a response arriving just before its
 * waiter is registered; callers must still generate unique request IDs.
 */
export class ControlRequestRegistry {
  #pending = new Map();
  #orphans = new Map();
  #maxOrphanResponses;
  #orphanTtlMs;
  #now;
  #closedError;

  constructor({ maxOrphanResponses = 64, orphanTtlMs = 5_000, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxOrphanResponses) || maxOrphanResponses < 0) {
      throw new RangeError('maxOrphanResponses must be a non-negative safe integer.');
    }
    if (!Number.isFinite(orphanTtlMs) || orphanTtlMs < 0) {
      throw new RangeError('orphanTtlMs must be a non-negative number.');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.#maxOrphanResponses = maxOrphanResponses;
    this.#orphanTtlMs = orphanTtlMs;
    this.#now = now;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  /** Wait for one response. An optional signal/timeout cleans up the waiter. */
  waitFor(requestId, { signal, timeoutMs } = {}) {
    if (typeof requestId !== 'string' || requestId.trim().length === 0) {
      return Promise.reject(new TypeError('requestId must be a non-empty string.'));
    }
    if (this.#closedError) return Promise.reject(this.#closedError);
    if (this.#pending.has(requestId)) {
      return Promise.reject(new Error(`A waiter already exists for request ${requestId}.`));
    }
    if (signal?.aborted) return Promise.reject(createAbortError(signal));
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return Promise.reject(new RangeError('timeoutMs must be a non-negative number.'));
    }

    const orphan = this.#takeOrphan(requestId);
    if (orphan) return this.#responsePromise(orphan);

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abortHandler: undefined, timer: undefined };
      const settle = (action, value) => {
        if (this.#pending.get(requestId) !== entry) return;
        this.#pending.delete(requestId);
        this.#cleanupEntry(entry);
        action(value);
      };
      entry.resolve = value => settle(resolve, value);
      entry.reject = error => settle(reject, error);

      if (signal) {
        entry.abortHandler = () => entry.reject(createAbortError(signal));
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => entry.reject(new ControlRequestTimeoutError(requestId, timeoutMs)), timeoutMs);
      }
      this.#pending.set(requestId, entry);
      if (signal?.aborted) entry.reject(createAbortError(signal));
    });
  }

  /** Accept a control_response frame; return false for unrelated/malformed frames. */
  accept(frame) {
    const requestId = readResponseId(frame);
    if (!requestId || this.#closedError) return false;

    const entry = this.#pending.get(requestId);
    if (entry) {
      if (frame.response?.subtype === 'error') {
        entry.reject(new ControlRequestError(
          typeof frame.response.error === 'string' ? frame.response.error : 'Control request failed.',
          { requestId, errorCode: frame.response.error_code, response: frame.response },
        ));
      } else {
        entry.resolve(frame.response);
      }
      return true;
    }

    if (this.#maxOrphanResponses === 0) return true;
    this.#purgeExpiredOrphans();
    this.#orphans.delete(requestId);
    this.#orphans.set(requestId, { response: frame.response, expiresAt: this.#now() + this.#orphanTtlMs });
    while (this.#orphans.size > this.#maxOrphanResponses) {
      this.#orphans.delete(this.#orphans.keys().next().value);
    }
    return true;
  }

  /** Reject all waiters and prevent future registrations. Safe to call repeatedly. */
  close(cause = new ControlRequestRegistryClosedError()) {
    if (this.#closedError) return;
    this.#closedError = cause instanceof Error ? cause : new Error(String(cause));
    this.#orphans.clear();
    for (const entry of this.#pending.values()) entry.reject(this.#closedError);
  }

  #responsePromise(response) {
    if (response?.subtype === 'error') {
      return Promise.reject(new ControlRequestError(
        typeof response.error === 'string' ? response.error : 'Control request failed.',
        { requestId: response.request_id, errorCode: response.error_code, response },
      ));
    }
    return Promise.resolve(response);
  }

  #takeOrphan(requestId) {
    this.#purgeExpiredOrphans();
    const orphan = this.#orphans.get(requestId);
    if (!orphan) return undefined;
    this.#orphans.delete(requestId);
    return orphan.response;
  }

  #purgeExpiredOrphans() {
    const now = this.#now();
    for (const [requestId, orphan] of this.#orphans) {
      if (orphan.expiresAt <= now) this.#orphans.delete(requestId);
    }
  }

  #cleanupEntry(entry) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
    }
  }
}

/** Build the protocol frame used to cancel a previously issued control request. */
export function createControlCancelFrame(requestId) {
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new TypeError('requestId must be a non-empty string.');
  }
  return { type: 'control_cancel_request', request_id: requestId };
}
