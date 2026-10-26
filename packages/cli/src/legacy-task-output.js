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
  #outputFileRedundant = false;
  #outputIdentity = null;
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
  get isOverflowed() {
    return this.stdoutToFile ? !this.#outputFileRedundant : this.#disk !== null;
  }
  get outputFileRedundant() {
    return this.stdoutToFile ? this.#outputFileRedundant : this.#disk === null;
  }

  // Original utils/Shell.ts exec(): prepare one exclusive output file FD,
  // pass this SAME descriptor for stdout and stderr, then close our own
  // duplicate after the child process has started.
  async initFileOutput() {
    if(!this.stdoutToFile)throw new Error('Only file-mode TaskOutput owns a shell output fd.');
    await mkdir(taskOutputDir,{recursive:true,mode:0o700});
    const flags=process.platform==='win32'
      ? 'wx'
      : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW??0);
    const handle=await open(this.path,flags,0o600);
    try {
      // Newer 2.1.304 ShellCommand also detects substituted/truncated
      // stdout files. Remember the actual opened file identity, not
      // merely its path, before sharing this FD with an untrusted Bash.
      const identity=await handle.stat({bigint:true});
      this.#outputIdentity={
        dev:identity.dev,ino:identity.ino,
        birthtimeNs:identity.birthtimeNs,
      };
      return handle;
    }catch(error) {
      await handle.close().catch(()=>{});
      throw error;
    }
  }

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
    if (this.stdoutToFile || this.#disk) {
      try { this.#outputFileSize=(await stat(this.path)).size; }
      catch(error) { throw new Error('TaskOutput file unavailable: '+error.message,{cause:error}); }
    }
  }

  async getStdout() {
    if(this.stdoutToFile) {
      // Original BASH_MAX_OUTPUT_DEFAULT = 30_000, upper limit 150_000.
      // Read only a bounded prefix as in 2.1.88 #readStdoutFromFile(),
      // not the entire command output. Full bytes stay on disk.
      const maxBytes=30000;
      // POSIX: never follow a symlink inserted into the output path.
      // Windows: use FileHandle.stat() identity instead of trusting the
      // pathname, because numeric O_NOFOLLOW is not portable via libuv.
      const flags=process.platform==='win32'
        ? 'r' : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW??0);
      const fh=await open(this.path,flags);
      try {
        const identity=await fh.stat({bigint:true});
        const expected=this.#outputIdentity;
        if(!expected || identity.dev!==expected.dev ||
          identity.ino!==expected.ino ||
          identity.birthtimeNs!==expected.birthtimeNs) {
          throw new Error('Bash TaskOutput file was replaced or cannot be verified.');
        }
        const size=Number(identity.size);
        this.#outputFileSize=size;
        const buf=Buffer.alloc(Math.min(size,maxBytes));
        let position=0;
        while(position<buf.length) {
          const {bytesRead}=await fh.read(buf,position,buf.length-position,position);
          if(!bytesRead)break;
          position+=bytesRead;
        }
        this.#outputFileRedundant=size<=position;
        const text=buf.subarray(0,position).toString('utf8');
        if(this.#outputFileRedundant)return text;
        return text+'\nOutput truncated ('+Math.round(size/1024)+
          'KB total). Full output saved to: '+this.path;
      }finally {
        await fh.close();
      }
    }
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
  getStderr() { return this.stdoutToFile||this.#disk?'':this.#stderrBuffer; }
  async deleteOutputFile() {
    // Original TaskOutput.deleteOutputFile is best-effort: when the entire
    // output is already in result.stdout, failing to delete a redundant
    // file must not strand the close handler or change the tool result.
    try { await unlink(this.path); } catch {}
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
      '['+Math.round((size-bytesRead)/1024)+'KB of earlier output omitted]\n'+tail : tail;
  } finally {
    await file.close();
  }
}
