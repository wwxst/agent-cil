import { Transform } from 'node:stream';

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** A recoverable error for one malformed JSONL frame. */
export class ProtocolFrameError extends Error {
  constructor(message, lineNumber, options) {
    super(message, options);
    this.name = 'ProtocolFrameError';
    this.lineNumber = lineNumber;
  }
}

/** A fatal framing error. The stream cannot safely continue after this error. */
export class FrameTooLargeError extends Error {
  constructor(maxFrameBytes, lineNumber) {
    super(`JSONL frame ${lineNumber} exceeds the ${maxFrameBytes}-byte limit.`);
    this.name = 'FrameTooLargeError';
    this.maxFrameBytes = maxFrameBytes;
    this.lineNumber = lineNumber;
  }
}

/**
 * Decode a byte stream containing one JSON object per line.
 *
 * Invalid JSON frames are reported through `frameError` and skipped so one
 * damaged diagnostic line does not corrupt subsequent frames. A frame-size
 * violation is fatal because continuing could allow unbounded memory growth.
 */
export class JsonlParser extends Transform {
  #buffer = Buffer.alloc(0);
  #lineNumber = 0;
  #maxFrameBytes;
  #firstFrame = true;

  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    super({ readableObjectMode: true, writableObjectMode: false });
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError('maxFrameBytes must be a positive safe integer.');
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  _transform(chunk, encoding, callback) {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.#buffer = this.#buffer.length === 0
        ? bytes
        : Buffer.concat([this.#buffer, bytes]);

      let newlineIndex;
      while ((newlineIndex = this.#buffer.indexOf(0x0a)) !== -1) {
        const line = this.#buffer.subarray(0, newlineIndex);
        this.#buffer = this.#buffer.subarray(newlineIndex + 1);
        this.#consumeLine(line);
      }

      if (this.#buffer.length > this.#maxFrameBytes) {
        throw new FrameTooLargeError(this.#maxFrameBytes, this.#lineNumber + 1);
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      if (this.#buffer.length > 0) {
        this.#consumeLine(this.#buffer);
        this.#buffer = Buffer.alloc(0);
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    this.#buffer = Buffer.alloc(0);
    callback(error);
  }

  #consumeLine(rawLine) {
    this.#lineNumber += 1;
    if (rawLine.length > this.#maxFrameBytes) {
      throw new FrameTooLargeError(this.#maxFrameBytes, this.#lineNumber);
    }

    let line = rawLine;
    if (line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }
    if (line.length === 0) return;

    if (this.#firstFrame) {
      this.#firstFrame = false;
      if (line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) {
        line = line.subarray(3);
      }
    }

    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(line);
      const value = JSON.parse(decoded);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('A protocol frame must be a JSON object.');
      }
      this.push(value);
    } catch (cause) {
      this.emit('frameError', new ProtocolFrameError(
        `Invalid JSON object on line ${this.#lineNumber}.`,
        this.#lineNumber,
        { cause },
      ));
    }
  }
}

/** Encode one protocol object as a UTF-8 JSONL frame, including its newline. */
export function encodeJsonlFrame(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A protocol frame must be a non-null JSON object.');
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError('Protocol frame could not be serialized as JSON.', { cause });
  }
  if (typeof serialized !== 'string') {
    throw new TypeError('Protocol frame did not serialize to JSON text.');
  }
  return `${serialized}\n`;
}
