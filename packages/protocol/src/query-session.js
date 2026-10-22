import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ControlRequestRegistry, createControlCancelFrame } from './control-requests.js';

/** Handler may return this sentinel when another execution host owns the request. */
export const NO_CONTROL_RESPONSE = Symbol('NO_CONTROL_RESPONSE');

function normalizeError(error) {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function errorResponse(requestId, error) {
  const normalized = normalizeError(error);
  const message = normalized.message.slice(0, 2_000) || 'Control handler failed.';
  const errorCode = typeof normalized.code === 'string' ? normalized.code : 'HANDLER_ERROR';
  return {
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error: message, error_code: errorCode },
  };
}

/**
 * A protocol-level Query channel over ProcessTransport.
 * It gates user input on initialize-frame write, dispatches host callbacks,
 * and keeps control request IDs separate from tool-use IDs.
 */
export class QueryProtocolSession extends EventEmitter {
  #transport;
  #registry;
  #requestIdFactory;
  #defaultControlTimeoutMs;
  #handlers = new Map();
  #pendingHandlers = new Map();
  #state = 'new';
  #initializeWritePromise;
  #initializeHasBeenWritten = false;
  #initializeResponsePromise;
  #initializeError;
  #closedError;

  constructor({
    transport,
    requestIdFactory = randomUUID,
    defaultControlTimeoutMs = 30_000,
    registry = new ControlRequestRegistry(),
  }) {
    super();
    if (!transport || typeof transport.start !== 'function' || typeof transport.writeFrame !== 'function' || typeof transport.close !== 'function') {
      throw new TypeError('transport must implement start(), writeFrame() and close().');
    }
    if (typeof requestIdFactory !== 'function') throw new TypeError('requestIdFactory must be a function.');
    if (!Number.isFinite(defaultControlTimeoutMs) || defaultControlTimeoutMs < 0) {
      throw new RangeError('defaultControlTimeoutMs must be a non-negative number.');
    }
    this.#transport = transport;
    this.#requestIdFactory = requestIdFactory;
    this.#defaultControlTimeoutMs = defaultControlTimeoutMs;
    this.#registry = registry;
  }

  get state() {
    return this.#state;
  }

  get initializeWritten() {
    return this.#initializeHasBeenWritten;
  }

  get pendingControlHandlerCount() {
    return this.#pendingHandlers.size;
  }

  registerControlHandler(subtype, handler) {
    if (typeof subtype !== 'string' || subtype.trim().length === 0) throw new TypeError('subtype must be a non-empty string.');
    if (typeof handler !== 'function') throw new TypeError('handler must be a function.');
    if (this.#handlers.has(subtype)) throw new Error(`A control handler is already registered for ${subtype}.`);
    this.#handlers.set(subtype, handler);
    return () => {
      if (this.#handlers.get(subtype) === handler) this.#handlers.delete(subtype);
    };
  }

  async start() {
    if (this.#state !== 'new') throw new Error(`Cannot start QueryProtocolSession in state ${this.#state}.`);
    this.#state = 'starting';
    this.#transport.on?.('frame', frame => this.#handleFrame(frame));
    this.#transport.on?.('frameError', error => this.emit('frameError', error));
    this.#transport.on?.('transportError', error => this.#handleTransportError(error));
    this.#transport.on?.('exit', result => this.#handleTransportExit(result));
    try {
      await this.#transport.start();
      if (this.#state !== 'starting') throw this.#closedError ?? new Error('Transport closed during Query startup.');
      this.#state = 'running';
      this.emit('started');
      return this;
    } catch (error) {
      this.#finishClose({ code: null, signal: null, error }, normalizeError(error));
      throw error;
    }
  }

  /**
   * Write initialize before any user input. The returned promise resolves on
   * the peer's control_response; sendInput only waits for the frame write, not
   * that response, matching the observed stream-input barrier semantics.
   */
  initialize(payload = {}, { signal, timeoutMs = this.#defaultControlTimeoutMs } = {}) {
    if (this.#state !== 'running') return Promise.reject(new Error(`Cannot initialize in state ${this.#state}.`));
    if (this.#initializeWritePromise) return Promise.reject(new Error('Query has already been initialized.'));
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return Promise.reject(new TypeError('initialize payload must be an object.'));
    }

    const requestId = this.#createRequestId();
    const responsePromise = this.#registry.waitFor(requestId, { signal, timeoutMs });
    this.#initializeResponsePromise = responsePromise;
    responsePromise.catch(error => {
      this.#initializeError = error;
      this.emit('initializeError', error);
    });
    this.#initializeWritePromise = Promise.resolve().then(() => this.#transport.writeFrame({
      type: 'control_request',
      request_id: requestId,
      request: { ...payload, subtype: 'initialize' },
    })).then(() => {
      this.#initializeHasBeenWritten = true;
      this.emit('initializeWritten', { requestId });
    }).catch(error => {
      this.#registry.close(normalizeError(error));
      throw error;
    });
    return responsePromise;
  }

  /** Write one input frame only after the initialize frame has been written. */
  async sendInput(frame) {
    if (this.#state !== 'running') throw new Error(`Cannot send input in state ${this.#state}.`);
    if (!this.#initializeWritePromise) throw new Error('Initialize must be called before sending input.');
    await this.#initializeWritePromise;
    if (this.#initializeError) throw this.#initializeError;
    if (this.#state !== 'running') throw this.#closedError ?? new Error('Query session is closed.');
    await this.#transport.writeFrame(frame);
    this.emit('inputWritten', frame);
  }

  /** Send a control request to the CLI and await its matching response. */
  async requestControl(subtype, payload = {}, { signal, timeoutMs = this.#defaultControlTimeoutMs } = {}) {
    if (this.#state !== 'running') throw new Error(`Cannot send control request in state ${this.#state}.`);
    if (typeof subtype !== 'string' || subtype.trim().length === 0) throw new TypeError('subtype must be a non-empty string.');
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('control payload must be an object.');
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Control request aborted.'), { name: 'AbortError' });

    const requestId = this.#createRequestId();
    const responsePromise = this.#registry.waitFor(requestId, { signal, timeoutMs });
    const onAbort = () => {
      if (this.#state === 'running') {
        void this.#transport.writeFrame(createControlCancelFrame(requestId)).catch(error => this.emit('transportError', error));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const writePromise = Promise.resolve().then(() => this.#transport.writeFrame({
      type: 'control_request',
      request_id: requestId,
      request: { ...payload, subtype },
    })).catch(error => {
      this.#registry.close(normalizeError(error));
      throw error;
    });

    try {
      const [, response] = await Promise.all([writePromise, responsePromise]);
      return response;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async close() {
    if (this.#state === 'closed') return this.#transport.exitResult;
    const error = new Error('Query protocol session closed.');
    error.name = 'AbortError';
    this.#state = 'closing';
    this.#registry.close(error);
    this.#abortPendingHandlers(error);
    try {
      const result = await this.#transport.close();
      this.#finishClose(result, error);
      return result;
    } catch (closeError) {
      this.#finishClose({ code: null, signal: null, error: closeError }, normalizeError(closeError));
      throw closeError;
    }
  }

  #createRequestId() {
    const id = this.#requestIdFactory();
    if (typeof id !== 'string' || id.trim().length === 0) throw new TypeError('requestIdFactory must return a non-empty string.');
    return id;
  }

  #handleFrame(frame) {
    if (this.#state === 'closed') return;
    if (frame?.type === 'control_response') this.#registry.accept(frame);
    if (frame?.type === 'control_cancel_request' && typeof frame.request_id === 'string') {
      this.#pendingHandlers.get(frame.request_id)?.abort(new Error('Peer cancelled the control request.'));
    }
    if (frame?.type === 'control_request') void this.#dispatchControlRequest(frame);
    this.emit('frame', frame);
  }

  async #dispatchControlRequest(frame) {
    const requestId = frame.request_id;
    const subtype = frame.request?.subtype;
    if (typeof requestId !== 'string' || requestId.trim().length === 0 || typeof subtype !== 'string') {
      this.emit('protocolWarning', new Error('Received malformed control_request frame.'));
      return;
    }
    if (this.#pendingHandlers.has(requestId)) {
      await this.#writeControlResponse(errorResponse(requestId, new Error('Duplicate control request id.')));
      return;
    }
    const handler = this.#handlers.get(subtype);
    if (!handler) {
      await this.#writeControlResponse(errorResponse(requestId, Object.assign(new Error(`No handler registered for control subtype ${subtype}.`), { code: 'UNHANDLED_CONTROL_REQUEST' })));
      return;
    }

    const controller = new AbortController();
    this.#pendingHandlers.set(requestId, controller);
    try {
      const result = await handler(frame.request, { requestId, signal: controller.signal, session: this });
      if (controller.signal.aborted || result === NO_CONTROL_RESPONSE || this.#state !== 'running') return;
      await this.#writeControlResponse({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: result === undefined ? {} : result },
      });
    } catch (error) {
      if (controller.signal.aborted || this.#state !== 'running') return;
      this.emit('controlHandlerError', { requestId, subtype, error });
      await this.#writeControlResponse(errorResponse(requestId, error));
    } finally {
      if (this.#pendingHandlers.get(requestId) === controller) this.#pendingHandlers.delete(requestId);
    }
  }

  async #writeControlResponse(frame) {
    if (this.#state !== 'running') return;
    try {
      await this.#transport.writeFrame(frame);
    } catch (error) {
      this.#handleTransportError(error);
    }
  }

  #handleTransportError(error) {
    const normalized = normalizeError(error);
    this.emit('transportError', normalized);
    if (this.#state === 'closed' || this.#state === 'closing') return;
    this.#state = 'closing';
    this.#registry.close(normalized);
    this.#abortPendingHandlers(normalized);
    void this.#transport.close().then(
      result => this.#finishClose(result, normalized),
      closeError => this.#finishClose({ code: null, signal: null, error: closeError }, normalizeError(closeError)),
    );
  }

  #handleTransportExit(result) {
    if (this.#state === 'closed') return;
    const error = result?.error ?? new Error(`CLI transport exited (code=${String(result?.code)}, signal=${String(result?.signal)}).`);
    this.#finishClose(result ?? { code: null, signal: null }, error);
  }

  #abortPendingHandlers(reason) {
    for (const controller of this.#pendingHandlers.values()) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    this.#pendingHandlers.clear();
  }

  #finishClose(result, error) {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#closedError = error;
    this.#registry.close(error ?? new Error('CLI transport closed.'));
    this.#abortPendingHandlers(error ?? new Error('CLI transport closed.'));
    this.emit('closed', { result, error });
  }
}
