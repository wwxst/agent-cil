import { EventEmitter } from 'node:events';

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Waiting for the Query run was aborted.');
  error.name = 'AbortError';
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

/**
 * Tracks the distinction between a CLI result and a completed host-side run.
 * Attach to a QueryProtocolSession, or feed frames through observe() directly.
 */
export class QueryRunLifecycle extends EventEmitter {
  #session;
  #hasBidirectionalNeeds;
  #runEndCeilingMs;
  #isSingleUserTurn;
  #state = 'idle';
  #sessionState;
  #resultReceived = false;
  #runEnded = false;
  #runEndReason;
  #runEndCeilingTimer;
  #waiters = new Set();
  #closedError;
  #onFrame;
  #onClosed;

  constructor({
    session,
    hasBidirectionalNeeds = false,
    runEndCeilingMs = 30_000,
    isSingleUserTurn = false,
  } = {}) {
    super();
    if (typeof hasBidirectionalNeeds !== 'boolean' && typeof hasBidirectionalNeeds !== 'function') {
      throw new TypeError('hasBidirectionalNeeds must be a boolean or function.');
    }
    if (!Number.isFinite(runEndCeilingMs) || runEndCeilingMs < 0) {
      throw new RangeError('runEndCeilingMs must be a non-negative number.');
    }
    if (typeof isSingleUserTurn !== 'boolean') throw new TypeError('isSingleUserTurn must be a boolean.');

    this.#session = session;
    this.#hasBidirectionalNeeds = hasBidirectionalNeeds;
    this.#runEndCeilingMs = runEndCeilingMs;
    this.#isSingleUserTurn = isSingleUserTurn;

    if (session !== undefined) {
      if (typeof session.on !== 'function' || typeof session.off !== 'function') {
        throw new TypeError('session must be an event emitter when provided.');
      }
      this.#onFrame = frame => this.observe(frame);
      this.#onClosed = ({ error } = {}) => this.close(error ?? new Error('Query session closed before the run ended.'));
      session.on('frame', this.#onFrame);
      session.on('closed', this.#onClosed);
    }
  }

  get state() {
    return this.#state;
  }

  get sessionState() {
    return this.#sessionState;
  }

  get resultReceived() {
    return this.#resultReceived;
  }

  get runEnded() {
    return this.#runEnded;
  }

  get runEndReason() {
    return this.#runEndReason;
  }

  beginRun() {
    if (this.#closedError) throw this.#closedError;
    if (this.#state === 'running' && !this.#runEnded) {
      throw new Error('A Query run is already active.');
    }
    this.#clearRunEndCeiling();
    this.#state = 'running';
    this.#resultReceived = false;
    this.#runEnded = false;
    this.#runEndReason = undefined;
    this.emit('runStarted');
  }

  /** Observe one protocol frame. Unrelated frames are ignored. */
  observe(frame) {
    if (this.#closedError || frame === null || typeof frame !== 'object') return false;

    if (frame.type === 'result') {
      if (this.#state !== 'running' || this.#runEnded) this.beginRun();
      this.#resultReceived = true;
      this.emit('result', frame);
      if (this.#sessionState === undefined || this.#sessionState === 'idle' || !this.#needsBidirectionalResponse()) {
        this.endRun('result');
      } else {
        this.#armRunEndCeiling();
      }
      return true;
    }

    if (frame.type === 'system' && frame.subtype === 'session_state_changed') {
      this.#sessionState = frame.state;
      this.emit('sessionStateChanged', { state: frame.state, frame });

      if (frame.state === 'idle') {
        if (this.#resultReceived) this.endRun('idle');
        return true;
      }

      if (this.#isSingleUserTurn && this.#runEnded) return true;
      if (this.#runEnded) {
        this.#runEnded = false;
        this.#state = 'running';
        this.#runEndReason = undefined;
        this.emit('runResumed', { state: frame.state });
      }
      if (frame.state === 'requires_action') {
        this.#clearRunEndCeiling();
      } else if (this.#resultReceived) {
        this.#armRunEndCeiling();
      }
      return true;
    }

    if ((frame.type === 'assistant' || frame.type === 'stream_event')
      && frame.parent_tool_use_id === null
      && !(this.#isSingleUserTurn && this.#runEnded)) {
      this.#clearRunEndCeiling();
      if (this.#runEnded) {
        this.#runEnded = false;
        this.#state = 'running';
        this.#runEndReason = undefined;
        this.emit('runResumed', { state: this.#sessionState, source: frame.type });
      }
    }
    return false;
  }

  waitForRunEnd({ signal } = {}) {
    if (this.#runEnded) return Promise.resolve(this.#runEndResult());
    if (this.#closedError) return Promise.reject(this.#closedError);
    if (this.#state !== 'running') return Promise.reject(new Error('No active Query run.'));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abortHandler: undefined };
      const cleanup = () => {
        this.#waiters.delete(waiter);
        signal?.removeEventListener('abort', waiter.abortHandler);
      };
      waiter.resolve = result => { cleanup(); resolve(result); };
      waiter.reject = error => { cleanup(); reject(error); };
      if (signal) {
        waiter.abortHandler = () => waiter.reject(abortError(signal));
        signal.addEventListener('abort', waiter.abortHandler, { once: true });
      }
      this.#waiters.add(waiter);
      if (signal?.aborted) waiter.reject(abortError(signal));
      else if (this.#runEnded) waiter.resolve(this.#runEndResult());
    });
  }

  endRun(reason = 'explicit') {
    if (this.#closedError || this.#runEnded || this.#state !== 'running') return false;
    this.#runEnded = true;
    this.#runEndReason = reason;
    this.#state = 'ended';
    this.#clearRunEndCeiling();
    const result = this.#runEndResult();
    for (const waiter of [...this.#waiters]) waiter.resolve(result);
    this.emit('runEnded', result);
    return true;
  }

  close(error = new Error('Query run lifecycle closed.')) {
    if (this.#closedError) return;
    this.#closedError = error instanceof Error ? error : new Error(String(error));
    this.#state = 'closed';
    this.#clearRunEndCeiling();
    for (const waiter of [...this.#waiters]) waiter.reject(this.#closedError);
    if (this.#session && this.#onFrame) this.#session.off('frame', this.#onFrame);
    if (this.#session && this.#onClosed) this.#session.off('closed', this.#onClosed);
    this.emit('closed', this.#closedError);
  }

  #needsBidirectionalResponse() {
    return typeof this.#hasBidirectionalNeeds === 'function'
      ? Boolean(this.#hasBidirectionalNeeds())
      : this.#hasBidirectionalNeeds;
  }

  #armRunEndCeiling() {
    this.#clearRunEndCeiling();
    if (this.#runEnded || this.#closedError || this.#runEndCeilingMs <= 0) return;
    this.#runEndCeilingTimer = setTimeout(() => {
      this.endRun('ceiling');
    }, this.#runEndCeilingMs);
  }

  #clearRunEndCeiling() {
    clearTimeout(this.#runEndCeilingTimer);
    this.#runEndCeilingTimer = undefined;
  }

  #runEndResult() {
    return { reason: this.#runEndReason, sessionState: this.#sessionState, resultReceived: this.#resultReceived };
  }
}
