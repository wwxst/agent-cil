import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { JsonlParser, encodeJsonlFrame } from './jsonl.js';

const DEFAULT_STDERR_TAIL_BYTES = 64 * 1024;

/**
 * Owns one child process and translates its stdout JSONL stream into frame events.
 * It deliberately does not implement Query, permissions, authentication or retries.
 */
export class ProcessTransport extends EventEmitter {
  #command;
  #args;
  #cwd;
  #env;
  #spawn;
  #maxFrameBytes;
  #stderrTailBytes;
  #killGracePeriodMs;
  #child;
  #parser;
  #state = 'new';
  #startPromise;
  #resolveStart;
  #rejectStart;
  #closePromise;
  #resolveClose;
  #exitResult;
  #shutdownTimer;
  #forceKillTimer;
  #stderrTail = Buffer.alloc(0);

  constructor({
    command,
    args = [],
    cwd,
    env,
    spawnImpl = nodeSpawn,
    maxFrameBytes,
    stderrTailBytes = DEFAULT_STDERR_TAIL_BYTES,
    killGracePeriodMs = 1_000,
    windowsHide = true,
  }) {
    super();
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new TypeError('command must be a non-empty string.');
    }
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
      throw new TypeError('args must be an array of strings.');
    }
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new TypeError('cwd must be a string when provided.');
    }
    if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
      throw new TypeError('env must be an object when provided.');
    }
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function.');
    if (!Number.isSafeInteger(stderrTailBytes) || stderrTailBytes < 0) {
      throw new RangeError('stderrTailBytes must be a non-negative safe integer.');
    }
    if (!Number.isFinite(killGracePeriodMs) || killGracePeriodMs < 0) {
      throw new RangeError('killGracePeriodMs must be a non-negative number.');
    }

    this.#command = command;
    this.#args = [...args];
    this.#cwd = cwd;
    this.#env = env === undefined ? undefined : { ...env };
    this.#spawn = spawnImpl;
    this.#maxFrameBytes = maxFrameBytes;
    this.#stderrTailBytes = stderrTailBytes;
    this.#killGracePeriodMs = killGracePeriodMs;
    this.windowsHide = windowsHide;
  }

  get state() {
    return this.#state;
  }

  get pid() {
    return this.#child?.pid;
  }

  get stderrTail() {
    return this.#stderrTail.toString('utf8');
  }

  get exitResult() {
    return this.#exitResult;
  }

  start() {
    if (this.#state !== 'new') throw new Error(`Cannot start transport in state ${this.#state}.`);
    this.#state = 'starting';
    this.#parser = new JsonlParser({ maxFrameBytes: this.#maxFrameBytes });
    this.#parser.on('data', frame => this.emit('frame', frame));
    this.#parser.on('frameError', error => this.emit('frameError', error));
    this.#parser.on('error', error => {
      this.emit('transportError', error);
      if (this.#state === 'running') {
        void this.close().catch(closeError => this.emit('transportError', closeError));
      }
    });
    this.#closePromise = new Promise(resolve => { this.#resolveClose = resolve; });

    this.#startPromise = new Promise((resolve, reject) => {
      this.#resolveStart = resolve;
      this.#rejectStart = reject;
      try {
        this.#child = this.#spawn(this.#command, [...this.#args], {
          cwd: this.#cwd,
          env: this.#env === undefined ? undefined : { ...this.#env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: this.windowsHide,
        });
      } catch (error) {
        this.#finalize(null, null, error);
        reject(error);
        return;
      }

      if (!this.#child?.stdin || !this.#child?.stdout || !this.#child?.stderr) {
        const error = new Error('spawnImpl must return a child process with stdin, stdout and stderr streams.');
        this.#finalize(null, null, error);
        reject(error);
        return;
      }

      this.#child.stdout.on('error', error => {
        this.emit('transportError', error);
        if (this.#state === 'running') void this.close().catch(closeError => this.emit('transportError', closeError));
      });
      this.#child.stderr.on('error', error => this.emit('transportError', error));
      this.#child.stdout.pipe(this.#parser);
      this.#child.stderr.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (this.#stderrTailBytes > 0) {
          this.#stderrTail = Buffer.concat([this.#stderrTail, bytes]).subarray(-this.#stderrTailBytes);
        }
        this.emit('stderr', bytes);
      });
      this.#child.stdin.on('error', error => this.emit('transportError', error));
      this.#child.on('spawn', () => {
        if (this.#state !== 'starting') return;
        this.#state = 'running';
        this.emit('started', { pid: this.#child.pid });
        resolve(this);
      });
      this.#child.on('error', error => {
        this.emit('transportError', error);
        if (this.#state === 'starting') {
          this.#finalize(null, null, error);
          reject(error);
        }
      });
      this.#child.on('close', (code, signal) => this.#finalize(code, signal));
    });

    return this.#startPromise;
  }

  writeFrame(frame) {
    if (this.#state !== 'running') {
      return Promise.reject(new Error(`Cannot write a frame in state ${this.#state}.`));
    }
    const stdin = this.#child.stdin;
    if (stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error('The child process stdin is closed.'));
    }
    const encoded = encodeJsonlFrame(frame);
    return new Promise((resolve, reject) => {
      try {
        stdin.write(encoded, error => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  endInput() {
    if (!this.#child || this.#state === 'new' || this.#state === 'closed') {
      return Promise.reject(new Error(`Cannot end input in state ${this.#state}.`));
    }
    const stdin = this.#child.stdin;
    if (stdin.writableEnded || stdin.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        stdin.removeListener('finish', onFinish);
        stdin.removeListener('error', onError);
      };
      const onFinish = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      stdin.once('finish', onFinish);
      stdin.once('error', onError);
      try {
        stdin.end();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  async close({ gracePeriodMs = this.#killGracePeriodMs } = {}) {
    if (!Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
      throw new RangeError('gracePeriodMs must be a non-negative number.');
    }
    if (this.#state === 'new') {
      this.#state = 'closed';
      this.#exitResult = { code: null, signal: null };
      return this.#exitResult;
    }
    if (this.#state === 'starting') {
      try { await this.#startPromise; } catch { return this.#exitResult; }
    }
    if (this.#state === 'closed') return this.#exitResult;

    if (this.#state === 'running') {
      this.#state = 'closing';
      try {
        if (!this.#child.stdin.destroyed && !this.#child.stdin.writableEnded) this.#child.stdin.end();
      } catch (error) {
        this.emit('transportError', error);
      }
      this.#shutdownTimer = setTimeout(() => {
        if (this.#state === 'closed') return;
        try { this.#child.kill('SIGTERM'); } catch (error) { this.emit('transportError', error); }
        this.#forceKillTimer = setTimeout(() => {
          if (this.#state === 'closed') return;
          try { this.#child.kill('SIGKILL'); } catch (error) { this.emit('transportError', error); }
        }, gracePeriodMs);
      }, gracePeriodMs);
    }
    return this.#closePromise;
  }

  #finalize(code, signal, error) {
    if (this.#state === 'closed') return;
    const wasStarting = this.#state === 'starting';
    this.#state = 'closed';
    clearTimeout(this.#shutdownTimer);
    clearTimeout(this.#forceKillTimer);
    this.#exitResult = { code, signal, ...(error === undefined ? {} : { error }) };
    if (this.#parser && !this.#parser.destroyed) this.#parser.end();
    this.emit('exit', this.#exitResult);
    this.#resolveClose?.(this.#exitResult);
    if (wasStarting) {
      this.#rejectStart?.(error ?? new Error('The child process closed before startup completed.'));
    }
  }
}
