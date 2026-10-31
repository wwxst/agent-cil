import { randomUUID } from 'node:crypto';
import { open, link, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertSessionId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new TypeError('Session ID must contain 1-128 letters, digits, underscores or hyphens.');
  }
  return id;
}

function assertSessionRecord(record) {
  if (!isRecord(record)) throw new TypeError('Session record must be an object.');
  assertSessionId(record.id);
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new TypeError('Session revision must be a non-negative safe integer.');
  }
  if (!['active', 'closed'].includes(record.status)) {
    throw new TypeError('Session status must be active or closed.');
  }
  if (!Array.isArray(record.messages) || !Array.isArray(record.turns)) {
    throw new TypeError('Session messages and turns must be arrays.');
  }
}

function clone(value) {
  return structuredClone(value);
}

export class SessionStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SessionStoreError';
  }
}

export class SessionConflictError extends SessionStoreError {
  constructor(message) {
    super(message);
    this.name = 'SessionConflictError';
  }
}

export class SessionNotFoundError extends SessionStoreError {
  constructor(id) {
    super('Session not found: ' + id);
    this.name = 'SessionNotFoundError';
  }
}

/** In-memory implementation of the revisioned session-store contract. */
export class InMemorySessionStore {
  #records = new Map();

  async create(record) {
    assertSessionRecord(record);
    if (record.revision !== 0) throw new TypeError('New sessions must start at revision 0.');
    if (this.#records.has(record.id)) throw new SessionConflictError('Session already exists: ' + record.id);
    this.#records.set(record.id, clone(record));
    return clone(record);
  }

  async get(id) {
    assertSessionId(id);
    const record = this.#records.get(id);
    return record === undefined ? undefined : clone(record);
  }

  async save(record, { expectedRevision } = {}) {
    assertSessionRecord(record);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative safe integer.');
    }
    const current = this.#records.get(record.id);
    if (!current) throw new SessionNotFoundError(record.id);
    if (current.revision !== expectedRevision) {
      throw new SessionConflictError('Session revision conflict for ' + record.id
        + ': expected ' + expectedRevision + ', found ' + current.revision + '.');
    }
    const next = clone(record);
    next.revision = current.revision + 1;
    this.#records.set(record.id, next);
    return clone(next);
  }

  async delete(id, { expectedRevision } = {}) {
    assertSessionId(id);
    const current = this.#records.get(id);
    if (!current) return false;
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new SessionConflictError('Session revision conflict for ' + id + '.');
    }
    this.#records.delete(id);
    return true;
  }
}

/**
 * Atomic JSON-file store for a single-writer host process.
 * Files are plaintext JSON; applications must choose a private directory and
 * protect/encrypt sensitive conversation data at the host layer when needed.
 */
export class FileSessionStore {
  #directory;
  #locks = new Map();

  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new TypeError('directory must be a non-empty path.');
    }
    this.#directory = path.resolve(directory);
  }

  async create(record) {
    assertSessionRecord(record);
    if (record.revision !== 0) throw new TypeError('New sessions must start at revision 0.');
    return this.#withLock(record.id, async () => {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const current = await this.#read(record.id);
      if (current) throw new SessionConflictError('Session already exists: ' + record.id);
      await this.#writeAtomic(record, { exclusive: true });
      return clone(record);
    });
  }

  async get(id) {
    assertSessionId(id);
    const record = await this.#read(id);
    return record === undefined ? undefined : clone(record);
  }

  async save(record, { expectedRevision } = {}) {
    assertSessionRecord(record);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('expectedRevision must be a non-negative safe integer.');
    }
    return this.#withLock(record.id, async () => {
      const current = await this.#read(record.id);
      if (!current) throw new SessionNotFoundError(record.id);
      if (current.revision !== expectedRevision) {
        throw new SessionConflictError('Session revision conflict for ' + record.id
          + ': expected ' + expectedRevision + ', found ' + current.revision + '.');
      }
      const next = clone(record);
      next.revision = current.revision + 1;
      await this.#writeAtomic(next);
      return clone(next);
    });
  }

  async delete(id, { expectedRevision } = {}) {
    assertSessionId(id);
    return this.#withLock(id, async () => {
      const current = await this.#read(id);
      if (!current) return false;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new SessionConflictError('Session revision conflict for ' + id + '.');
      }
      await unlink(this.#filePath(id));
      return true;
    });
  }

  async #read(id) {
    try {
      const text = await readFile(this.#filePath(id), 'utf8');
      let record;
      try {
        record = JSON.parse(text);
        assertSessionRecord(record);
      } catch (cause) {
        throw new SessionStoreError('Stored session is invalid: ' + id, { cause });
      }
      if (record.id !== id) throw new SessionStoreError('Stored session ID does not match its file name: ' + id);
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async #writeAtomic(record, { exclusive = false } = {}) {
    const serialized = JSON.stringify(record);
    if (typeof serialized !== 'string') throw new SessionStoreError('Session record is not JSON-serializable.');
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const target = this.#filePath(record.id);
    const temporary = path.join(this.#directory, '.' + record.id + '.' + randomUUID() + '.tmp');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      if (exclusive) {
        await link(temporary, target);
      } else {
        await rename(temporary, target);
      }
    } catch (error) {
      if (exclusive && error?.code === 'EEXIST') {
        throw new SessionConflictError('Session already exists: ' + record.id);
      }
      throw error;
    } finally {
      await unlink(temporary).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  #filePath(id) {
    return path.join(this.#directory, assertSessionId(id) + '.json');
  }

  async #withLock(id, operation) {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.#locks.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    }
  }
}
