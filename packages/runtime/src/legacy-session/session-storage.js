/**
 * CLI-only durable dependency closure for original 2.1.88
 * utils/sessionStorage.ts enqueueWrite / appendToFile / loadTranscriptFile.
 *
 * Source uses append-only JSONL and excludes ephemeral progress from the
 * transcript. Current Node messages lack source UUID/parentUuid fields, so
 * write *complete committed transcript checkpoints*, never partial SSE/tool
 * streams, in an explicitly versioned journal. This is NOT the full
 * source-native sessionStorage.ts JSONL message-chain format.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, realpath, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const ZERO = '0'.repeat(64);
const CHECKPOINT_TYPES = new Set(['tool', 'finished', 'compact']);
const NOFOLLOW = constants.O_NOFOLLOW || 0;
function digest(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
function validMessage(message) {
  return message && typeof message === 'object' && !Array.isArray(message) &&
    (message.role === 'assistant' || message.role === 'user') &&
    (typeof message.content === 'string' || Array.isArray(message.content));
}
/** An orphan tool_use, mismatched tool_result, duplicate id or incomplete
 * result cannot become a restart checkpoint. Text-only user messages remain
 * valid and can be saved after normal assistant completion. */
/**
 * Original Query resumes pending work from a complete tool_result rather
 * than requiring the user to supply another user prompt. The latest
 * checkpoint must end with the full tool batch, not a completed assistant
 * answer. Only a validated, paired terminal tool round may auto-continue.
 */
export function hasPendingToolResponse(messages) {
  if (!Array.isArray(messages) || messages.length < 3) return false;
  const last = messages.at(-1), previous = messages.at(-2);
  if (last?.role !== 'user' || !Array.isArray(last.content) ||
      previous?.role !== 'assistant' || !Array.isArray(previous.content)) {
    return false;
  }
  const ids = previous.content
    .filter(block => block?.type === 'tool_use')
    .map(block => block.id);
  const results = last.content
    .filter(block => block?.type === 'tool_result')
    .map(block => block.tool_use_id);
  return ids.length > 0 && ids.length === results.length &&
    new Set(ids).size === ids.length &&
    results.length === new Set(results).size &&
    ids.every(id => results.includes(id));
}
export function validateCommittedTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0 ||
      messages.some(m => !validMessage(m))) {
    throw new TypeError('A session checkpoint needs complete user/assistant messages.');
  }
  const pending = new Set();
  const seen = new Set();
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new TypeError('Malformed transcript content block.');
      }
      if (message.role === 'assistant' && block.type === 'tool_use') {
        if (typeof block.id !== 'string' || !block.id || seen.has(block.id)) {
          throw new Error('Duplicate or malformed persisted tool_use ID.');
        }
        pending.add(block.id);
        seen.add(block.id);
      }
      if (message.role === 'user' && block.type === 'tool_result') {
        if (!pending.delete(block.tool_use_id)) {
          throw new Error('Persisted tool_result has no matching unfinished tool_use.');
        }
      }
    }
  }
  if (pending.size) {
    throw new Error('Incomplete tool batch cannot be persisted: ' + [...pending].join(', '));
  }
  return messages;
}
async function safeDirectory(path) {
  try { await mkdir(path, { mode:0o700 }); }
  catch(error) { if(error?.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Session directory is not a real directory: ' + path);
  }
}
async function safeExistingFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Session journal is not a regular file.');
  }
  if(info.size > MAX_JOURNAL_BYTES)throw new RangeError('Session journal exceeds 64 MiB.');
}
function isPidActive(pid) {
  if(!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch(error) { return error?.code !== 'ESRCH'; }
}
async function acquireLock(path) {
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const lock=await open(path, constants.O_CREAT|constants.O_EXCL|
        constants.O_WRONLY|NOFOLLOW,0o600);
      try {
        await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:Date.now()})+'\n');
        await lock.sync();
      }finally{await lock.close();}
      return;
    }catch(error) {
      if(error?.code!=='EEXIST' || attempt)throw error;
      // A killed process leaves its lock. Never remove a live writer's lock.
      let text;
      try{
        const info=await lstat(path);
        if(!info.isFile() || info.isSymbolicLink())throw new Error('Invalid session lock.');
        text=await readFile(path,'utf8');
      }catch(inner){if(inner?.code==='ENOENT')continue;throw inner;}
      let pid;
      try{pid=JSON.parse(text).pid;}catch{throw new Error('Malformed session lock; manual recovery required.');}
      if(isPidActive(pid))throw new Error('Session is already active in another process.');
      await unlink(path);
    }
  }
}

export class SessionJournal {
  #path;
  #lock;
  #id;
  #workspace;
  #sequence=0;
  #previousHash=ZERO;
  #messages=[];
  #closed=false;
  #poisoned=false;
  #lastEncoded='';
  #lastKind;
  constructor({path,lock,id,workspace}){
    this.#path=path;this.#lock=lock;this.#id=id;this.#workspace=workspace;
  }
  get id(){return this.#id;}
  get messages(){return structuredClone(this.#messages);}
  get path(){return this.#path;}
  get canContinueWithoutPrompt(){
    return (this.#lastKind === 'tool' || this.#lastKind === 'compact') &&
      hasPendingToolResponse(this.#messages);
  }
  async load() {
    await safeExistingFile(this.#path);
    const file=await open(this.#path,constants.O_RDONLY|NOFOLLOW);
    let data;
    try{data=await file.readFile('utf8');}finally{await file.close();}
    if(!data.includes('\n'))throw new Error('Session has no complete checkpoint.');
    const lastLine=data.lastIndexOf('\n');
    const complete=data.slice(0,lastLine+1);
    const records=complete.split('\n').filter(Boolean);
    for(const line of records) {
      let record;
      try{record=JSON.parse(line);}catch{throw new Error('Corrupted session checkpoint JSONL.');}
      const {hash,...payload}=record;
      if(payload.type!=='session_checkpoint' || payload.version!==1 ||
        payload.sessionId!==this.#id || payload.workspace!==this.#workspace ||
        !CHECKPOINT_TYPES.has(payload.kind) ||
        payload.sequence!==this.#sequence+1 ||
        payload.previousHash!==this.#previousHash ||
        hash!==digest(payload)) {
        throw new Error('Invalid or modified session checkpoint chain.');
      }
      validateCommittedTranscript(payload.messages);
      this.#sequence=payload.sequence;
      this.#previousHash=hash;
      this.#messages=structuredClone(payload.messages);
      this.#lastEncoded=JSON.stringify(this.#messages);
      this.#lastKind=payload.kind;
    }
    if(!this.#sequence)throw new Error('Session has no committed messages to resume.');
    // A crash can truncate the last JSONL line. Never use that partial entry;
    // trim it under the exclusive session lock before any new append.
    if(lastLine+1 < data.length){
      const handle=await open(this.#path,constants.O_WRONLY|NOFOLLOW);
      try{await handle.truncate(Buffer.byteLength(complete));await handle.sync();}
      finally{await handle.close();}
    }
    return this.messages;
  }
  async append({messages,kind}) {
    if(this.#closed || this.#poisoned)throw new Error('Session journal is not writable.');
    if(!CHECKPOINT_TYPES.has(kind))throw new TypeError('Invalid session checkpoint kind.');
    validateCommittedTranscript(messages);
    const encoded=JSON.stringify(messages);
    if(Buffer.byteLength(encoded)>MAX_CHECKPOINT_BYTES)
      throw new RangeError('Session checkpoint exceeds 8 MiB.');
    if(encoded===this.#lastEncoded)return;
    const payload={
      type:'session_checkpoint',version:1,sessionId:this.#id,
      workspace:this.#workspace,kind,
      sequence:this.#sequence+1,previousHash:this.#previousHash,
      messages:JSON.parse(encoded),
    };
    const hash=digest(payload);
    const line=JSON.stringify({...payload,hash})+'\n';
    const handle=await open(this.#path,constants.O_WRONLY|constants.O_APPEND|NOFOLLOW);
    try {
      const before=(await handle.stat()).size;
      if(before+Buffer.byteLength(line)>MAX_JOURNAL_BYTES){
        throw new RangeError('Session journal exceeds 64 MiB.');
      }
      await handle.writeFile(line);
      await handle.sync();
    }catch(error){this.#poisoned=true;throw error;}
    finally{await handle.close();}
    this.#messages=structuredClone(messages);
    this.#lastEncoded=encoded;
    this.#previousHash=hash;
    this.#lastKind=kind;
    this.#sequence++;
  }
  async close() {
    if(this.#closed)return;
    this.#closed=true;
    await unlink(this.#lock).catch(error=>{
      if(error?.code!=='ENOENT')throw error;
    });
  }
}
export async function openSessionJournal({workspace,sessionId=randomUUID(),resume=false}={}){
  if(typeof workspace!=='string')throw new TypeError('Session workspace must be a directory.');
  if(typeof sessionId!=='string' || !UUID.test(sessionId))
    throw new TypeError('Session ID must be a UUID.');
  const root=await realpath(resolve(workspace));
  const prefix=join(root,'.agent-cil');
  const sessions=join(prefix,'sessions');
  const directory=join(sessions,sessionId);
  for(const path of [prefix,sessions,directory])await safeDirectory(path);
  const path=join(directory,'transcript.jsonl');
  const lock=path+'.lock';
  await acquireLock(lock);
  const journal=new SessionJournal({path,lock,id:sessionId,workspace:root});
  try{
    if(resume)await journal.load();
    else {
      // Original session creation must not silently overwrite an existing
      // transcript or corrupt the parentUuid / checkpoint chain.
      const handle=await open(path,constants.O_CREAT|constants.O_EXCL|
        constants.O_WRONLY|NOFOLLOW,0o600);
      await handle.close();
    }
    return journal;
  }catch(error){await journal.close();throw error;}
}
