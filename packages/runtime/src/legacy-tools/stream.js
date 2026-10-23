/**
 * Port of CLI 2.1.88 restored-src/src/utils/stream.ts.
 * Original notice: © Anthropic PBC. All rights reserved.
 *
 * Converted from TypeScript to Node 22 ESM; queue/read/return/error
 * behavior is retained to support the old runToolUse streaming bridge.
 */
export class Stream {
  #queue = [];
  #readResolve;
  #readReject;
  #isDone = false;
  #hasError;
  #started = false;
  #returned;

  constructor(returned) {
    this.#returned = returned;
  }

  [Symbol.asyncIterator]() {
    if (this.#started) throw new Error('Stream can only be iterated once');
    this.#started = true;
    return this;
  }

  next() {
    if (this.#queue.length > 0) {
      return Promise.resolve({ done: false, value: this.#queue.shift() });
    }
    if (this.#isDone) {
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#hasError) {
      return Promise.reject(this.#hasError);
    }
    return new Promise((resolve, reject) => {
      this.#readResolve = resolve;
      this.#readReject = reject;
    });
  }

  enqueue(value) {
    if (this.#readResolve) {
      const resolve = this.#readResolve;
      this.#readResolve = undefined;
      this.#readReject = undefined;
      resolve({ done: false, value });
    } else {
      this.#queue.push(value);
    }
  }

  done() {
    this.#isDone = true;
    if (this.#readResolve) {
      const resolve = this.#readResolve;
      this.#readResolve = undefined;
      this.#readReject = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  error(error) {
    this.#hasError = error;
    if (this.#readReject) {
      const reject = this.#readReject;
      this.#readResolve = undefined;
      this.#readReject = undefined;
      reject(error);
    }
  }

  return() {
    this.#isDone = true;
    this.#returned?.();
    return Promise.resolve({ done: true, value: undefined });
  }
}
