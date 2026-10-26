// Port of the pipe-mode TaskOutput → DiskTaskOutput dependency closure from
// pinned Claude CLI 2.1.88 restored-src/src/utils/task/{TaskOutput,diskOutput}.ts.
//
// The original uses a per-session project temp path and 5 GiB disk cap.
// This headless CLI has no LocalShellTask session registry yet; each process
// owns a random, mode-0700 OS temp directory. Output paths stay stable after
// command completion, so tool_result readers can inspect the original bytes.
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB';
const OUTPUT_MEMORY_BYTES = 1024 * 1024;
const MAX_RETURN_TAIL_BYTES = 8192;
const taskOutputDir = join(tmpdir(), 'agent-cil-task-'+process.pid+'-'+randomUUID());

export function getTaskOutputPath(taskId) {
  if (typeof taskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(taskId))
    throw new TypeError('Task output requires a generated UUID.');
  return join(taskOutputDir, taskId + '.output');
}

export class DiskTaskOutput {
  #path;
  #queue = [];
  #bytesWritten = 0;
  #capped = false;
  #flushPromise = null;
  #failure = null;
  #created = false;
  constructor(taskId) {
    this.#path = getTaskOutputPath(taskId);
  }
  get path() { return this.#path; }

  append(content) {
    // Keep stream 'data' listeners non-throwing; flush() owns the
    // persistence failure at the authenticated tool completion boundary.
    if (this.#failure || this.#capped) return;
    const count = Buffer.byteLength(content, 'utf8');
    this.#bytesWritten += count;
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true;
      this.#queue.push('\n[output truncated: exceeded '+MAX_TASK_OUTPUT_BYTES_DISPLAY+' disk cap]\n');
    } else this.#queue.push(content);
    if (!this.#flushPromise) {
      const promise = this.#drain();
      this.#flushPromise = promise;
      // Avoid an unhandled rejection before the final Bash result flush.
      void promise.catch(() => {});
      void promise.finally(() => {
        if (this.#flushPromise === promise) this.#flushPromise = null;
      }).catch(() => {});
    }
  }

  async #drain() {
    try {
      // The source uses O_NOFOLLOW for task file writes so untrusted
      // workspace symlinks cannot redirect process output.
      await mkdir(taskOutputDir, { recursive:true, mode:0o700 });
      // Retain the original source drain's post-close queue check:
      // append() can run while await fh.close() is pending. If we exit
      // here, those bytes would silently never be written on a later flush.
      while(true) {
        const flags = process.platform === 'win32'
          ? (this.#created ? 'a' : 'ax')
          : fsConstants.O_WRONLY | fsConstants.O_APPEND |
            (this.#created ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL) |
            (fsConstants.O_NOFOLLOW ?? 0);
        const fh = await open(this.#path, flags, 0o600);
        this.#created = true;
        try {
          while (this.#queue.length) {
            const chunks = this.#queue.splice(0);
            const buffers = chunks.map(x => Buffer.from(x,'utf8'));
            for (const buffer of buffers) await fh.writeFile(buffer);
          }
        } finally {
          await fh.close();
        }
        if(this.#queue.length===0)break;
      }
    } catch(error) {
      this.#failure = error;
      throw error;
    }
  }

  async flush() {
    while (this.#flushPromise) await this.#flushPromise;
    if (this.#failure) throw this.#failure;
  }
  cancel() { this.#queue.length=0; }
}

export class TaskOutput {
  taskId;
  path;
  stdoutToFile = false;
  #stdoutBuffer = '';
  #stderrBuffer = '';
  #disk = null;
  #tail = '';
  #totalBytes = 0;
  #maxMemory;
  #outputFileSize = 0;
  #onProgress;

  constructor(taskId = randomUUID(), onProgress = null, stdoutToFile = false,
      maxMemory = OUTPUT_MEMORY_BYTES) {
    this.taskId=taskId;
    this.path=getTaskOutputPath(taskId);
    this.stdoutToFile=stdoutToFile;
    this.#maxMemory=maxMemory;
    this.#onProgress=onProgress;
  }
  get totalBytes() { return this.#totalBytes; }
  get outputFileSize() { return this.#outputFileSize; }
  get isOverflowed() { return this.#disk !== null; }
  get outputFileRedundant() { return this.#disk === null; }

  writeStdout(data) { this.#writeBuffered(data,false); }
  writeStderr(data) { this.#writeBuffered(data,true); }

  #writeBuffered(data, isStderr) {
    if (!data) return;
    this.#totalBytes += Buffer.byteLength(data, 'utf8');
    this.#tail = (this.#tail+data).slice(-MAX_RETURN_TAIL_BYTES);
    if (this.#disk) {
      this.#disk.append(isStderr ? '[stderr] '+data : data);
      return;
    }
    if (this.#totalBytes > this.#maxMemory) {
      this.spillToDisk();
      this.#disk.append(isStderr ? '[stderr] '+data : data);
    } else if (isStderr) this.#stderrBuffer+=data;
    else this.#stdoutBuffer+=data;
    this.#onProgress?.(this.#tail,this.#tail,0,this.#totalBytes,this.isOverflowed);
  }

  spillToDisk() {
    if (this.#disk) return;
    this.#disk=new DiskTaskOutput(this.taskId);
    if (this.#stdoutBuffer) this.#disk.append(this.#stdoutBuffer);
    if (this.#stderrBuffer) this.#disk.append('[stderr] '+this.#stderrBuffer);
    this.#stdoutBuffer='';
    this.#stderrBuffer='';
  }

  async flush() {
    await this.#disk?.flush();
    if (this.#disk) {
      try { this.#outputFileSize=(await stat(this.path)).size; }
      catch(error) { throw new Error('TaskOutput file unavailable: '+error.message,{cause:error}); }
    }
  }

  async getStdout() {
    if (this.#disk) {
      await this.flush();
      const sizeKB=Math.round(this.#totalBytes/1024);
      // Source TaskOutput returns a concise recent tail and a reference to
      // the complete disk output; the model cannot receive multi-GiB text.
      return this.#tail+'\nOutput truncated ('+sizeKB+
        'KB total). Full output saved to: '+this.path;
    }
    return this.#stdoutBuffer;
  }
  getStderr() { return this.#disk?'':this.#stderrBuffer; }
  async deleteOutputFile() {
    try { await unlink(this.path); } catch(error) {
      if (error?.code!=='ENOENT') throw error;
    }
  }
  clear() {
    this.#stdoutBuffer='';
    this.#stderrBuffer='';
    this.#tail='';
    this.#onProgress=null;
    this.#disk?.cancel();
  }
}

export async function getTaskOutput(taskId, maxBytes=8*1024*1024) {
  // Source diskOutput.getTaskOutput() reads a bounded tail, not the whole
  // task file. Large Bash logs may be gigabytes; never Buffer the full file.
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>8*1024*1024)
    throw new RangeError('Task output tail must be 1..8388608 bytes.');
  const file=await open(getTaskOutputPath(taskId),'r');
  try {
    const size=(await file.stat()).size;
    const buffer=Buffer.alloc(Math.min(maxBytes,size));
    const {bytesRead}=await file.read(buffer,0,buffer.length,
      Math.max(0,size-buffer.length));
    const tail=buffer.subarray(0,bytesRead).toString('utf8');
    return size>bytesRead?
      '['+Math.round((size-bytesRead)/1024)+'KB of earlier output omitted]\\n'+tail : tail;
  } finally {
    await file.close();
  }
}
