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
import { insertMessageChain, applyMessageChain } from './native-transcript-chain.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const ZERO = '0'.repeat(64);
const CHECKPOINT_TYPES = new Set(['input', 'tool_pending', 'tool_partial', 'tool', 'finished', 'compact']);
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
  // Original Query emits separate user tool_result messages; the original
  // normalizeMessagesForAPI() merges adjacent user messages for the provider.
  // Accept either one aggregated tool_result turn or source-native sibling
  // result messages recovered by recoverOrphanedParallelToolResults().
  let index=messages.length-1;
  const results=[];
  while(index>=0) {
    const message=messages[index];
    if(message?.role!=='user' || !Array.isArray(message.content))break;
    const ids=message.content
      .filter(block=>block?.type==='tool_result')
      .map(block=>block.tool_use_id);
    if(!ids.length)break;
    results.unshift(...ids);
    index--;
  }
  const previous=messages[index];
  if(previous?.role!=='assistant' || !Array.isArray(previous.content))
    return false;
  const ids=previous.content
    .filter(block=>block?.type==='tool_use')
    .map(block=>block.id);
  return ids.length>0 && ids.length===results.length &&
    new Set(ids).size===ids.length &&
    new Set(results).size===results.length &&
    ids.every(id=>results.includes(id));
}
// Source 2.1.88 insertMessageChain() materializes the first user message
// before a provider responds. A persisted, unanswered user prompt is safe to
// retry; a tool_result is not an ordinary new prompt.
export function hasPendingUserInput(messages) {
  const last = Array.isArray(messages) ? messages.at(-1) : undefined;
  return last?.role === 'user' && typeof last.content === 'string' &&
    last.content.trim().length > 0;
}
export function validateCommittedTranscript(messages, {allowPendingTools=false,allowPartialTools=false} = {}) {
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
  if(allowPendingTools) {
    const last=messages.at(-1);
    const ids=last?.role==='assistant' && Array.isArray(last.content)
      ? last.content.filter(block=>block?.type==='tool_use').map(block=>block.id) : [];
    if(!ids.length || pending.size!==ids.length ||
       !ids.every(id=>pending.has(id))) {
      throw new Error('Pending tool checkpoint requires one complete assistant tool_use batch.');
    }
  } else if(allowPartialTools) {
    const assistantIndex=messages.findLastIndex(m=>m.role==='assistant' &&
      Array.isArray(m.content) && m.content.some(b=>b?.type==='tool_use'));
    const assistant=messages[assistantIndex];
    const ids=assistant?.content.filter(b=>b?.type==='tool_use').map(b=>b.id)??[];
    const results=messages.slice(assistantIndex+1);
    // Original StreamingToolExecutor.getCompletedResults() yields an
    // authenticated prefix of the model's tool_use order, even when safe
    // siblings finish out of order. Do not accept a checksum-valid journal
    // whose first result belongs to a later tool or whose earlier result
    // was silently omitted. Unfinished tails remain unsafe to replay.
    const completed=results.map(m=>m?.role==='user' && Array.isArray(m.content)
      ? m.content.filter(b=>b?.type==='tool_result')
      : []);
    if(assistantIndex<0 || !pending.size || pending.size>=ids.length ||
       !completed.length ||
       completed.some((blocks,index)=>blocks.length!==1 ||
         blocks[0].tool_use_id!==ids[index]) ||
       !ids.slice(completed.length).every(id=>pending.has(id)) ||
       ids.slice(0,completed.length).some(id=>pending.has(id))) {
      throw new Error('Partial tool checkpoint must contain an ordered prefix of completed tool results with a pending suffix.');
    }
  } else if (pending.size) {
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
async function assertLockOwner(path,token){
  let handle;
  try{
    handle=await open(path,constants.O_RDONLY|NOFOLLOW);
    const info=await handle.stat();
    if(!info.isFile())throw new Error('Invalid session lock.');
    const lock=JSON.parse(await handle.readFile('utf8'));
    if(lock.token!==token || lock.pid!==process.pid){
      throw new Error('Session lock ownership lost; refusing to access this session.');
    }
  }catch(error){
    if(error?.code==='ENOENT')throw new Error('Session lock disappeared; refusing to access this session.');
    if(error instanceof SyntaxError)throw new Error('Session lock was corrupted.');
    throw error;
  }finally{await handle?.close();}
}
async function acquireLock(path) {
  const token=randomUUID();
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const lock=await open(path, constants.O_CREAT|constants.O_EXCL|
        constants.O_WRONLY|NOFOLLOW,0o600);
      try {
        await lock.writeFile(JSON.stringify({
          pid:process.pid,startedAt:Date.now(),token,
        })+'\n');
        await lock.sync();
      }finally{await lock.close();}
      // A different process could be reclaiming a stale lock at the same
      // time. Do not grant write access if it already replaced our owner.
      await assertLockOwner(path,token);
      return token;
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
  #lockToken;
  #id;
  #workspace;
  #sequence=0;
  #previousHash=ZERO;
  #messages=[];
  #closed=false;
  #poisoned=false;
  // The original sessionStorage.ts enqueueWrite/drainWriteQueue serializes
  // each file's writes. Keep both the chain state and fsync in one queue.
  #writeQueue=Promise.resolve();
  #closeTask;
  #lastEncoded='';
  #lastKind;
  #nodes = new Map();
  #leafUuid = null;
  // 2.1.304 fences transcript writes after storage failures. Record the
  // actual on-disk file identity and committed length as a Node fd adapter;
  // a session lock alone does not protect against external replacement.
  #fileState;
  async attachFile() {
    const info=await lstat(this.#path);
    if(!info.isFile() || info.isSymbolicLink() || info.size>MAX_JOURNAL_BYTES)
      throw new Error('Session transcript is not a valid regular file.');
    this.#fileState={dev:info.dev,ino:info.ino,size:info.size};
  }
  async #assertTranscriptFile(handle,expectedSize) {
    const info=await handle.stat();
    const atPath=await lstat(this.#path);
    const expected=this.#fileState;
    if(!expected || !info.isFile() || !atPath.isFile() ||
       atPath.isSymbolicLink() || info.size!==expectedSize ||
       info.dev!==expected.dev || info.ino!==expected.ino ||
       atPath.dev!==expected.dev || atPath.ino!==expected.ino ||
       atPath.size!==expectedSize) {
      throw new Error('Session transcript was externally replaced or modified; writes fenced.');
    }
    return info;
  }
  constructor({path,lock,lockToken,id,workspace}){
    this.#path=path;this.#lock=lock;this.#lockToken=lockToken;
    this.#id=id;this.#workspace=workspace;
  }
  get id(){return this.#id;}
  get messages(){return structuredClone(this.#messages);}
  get path(){return this.#path;}
  get needsToolReconciliation(){
    return this.#lastKind==='tool_pending' || this.#lastKind==='tool_partial';
  }
  get canContinueWithoutPrompt(){
    return ((this.#lastKind === 'tool' || this.#lastKind === 'compact') &&
      hasPendingToolResponse(this.#messages)) ||
      (this.#lastKind === 'input' && hasPendingUserInput(this.#messages));
  }
  async load() {
    await assertLockOwner(this.#lock,this.#lockToken);
    await safeExistingFile(this.#path);
    const file=await open(this.#path,constants.O_RDONLY|NOFOLLOW);
    let data,readIdentity;
    try{
      const before=await file.stat();
      data=await file.readFile('utf8');
      const after=await file.stat();
      if(before.dev!==after.dev || before.ino!==after.ino ||
         before.size!==after.size || Buffer.byteLength(data)!==after.size) {
        throw new Error('Session transcript changed while being loaded.');
      }
      readIdentity=after;
    }finally{await file.close();}
    if(!data.includes('\n'))throw new Error('Session has no complete checkpoint.');
    const lastLine=data.lastIndexOf('\n');
    const complete=data.slice(0,lastLine+1);
    const records=complete.split('\n').filter(Boolean);
    for(const line of records) {
      let record;
      try{record=JSON.parse(line);}catch{throw new Error('Corrupted session checkpoint JSONL.');}
      const {hash,...payload}=record;
      if(payload.sessionId!==this.#id || payload.workspace!==this.#workspace ||
        !CHECKPOINT_TYPES.has(payload.kind) ||
        payload.sequence!==this.#sequence+1 ||
        payload.previousHash!==this.#previousHash ||
        hash!==digest(payload)) {
        throw new Error('Invalid or modified session checkpoint chain.');
      }
      if (payload.type === 'session_checkpoint' && payload.version === 1) {
        // v1 had no input kind; reject synthetic input records masquerading
        // as a legacy snapshot, even with a recomputed checksum.
        if(payload.kind === 'input' || payload.kind === 'tool_partial')
          throw new Error('Legacy checkpoint kind was never supported.');
        // Read-only migration of already shipped v1 whole-transcript records.
        // New writes always use source-style UUID/parentUuid message chains.
        if(this.#nodes.size)throw new Error('Cannot revert a session to legacy snapshots.');
        validateCommittedTranscript(payload.messages);
        this.#messages=structuredClone(payload.messages);
        this.#leafUuid=null;
      } else if(payload.type === 'session_commit' && payload.version === 2) {
        if(this.#messages.length && !this.#leafUuid && !payload.migration)
          throw new Error('Legacy session migration boundary is missing.');
        if(payload.migration && (this.#leafUuid!==null || !this.#messages.length))
          throw new Error('Invalid duplicate legacy migration.');
        if(payload.root && this.#leafUuid && payload.kind!=='compact')
          throw new Error('Only compact may reset the committed parent chain.');
        if(!payload.root && !this.#leafUuid)
          throw new Error('Incremental session message chain has no parent.');
        const restored=applyMessageChain({
          existing:this.#nodes,entries:payload.entries,leafUuid:payload.leafUuid,
          sessionId:this.#id,allowRoot:payload.root,previousLeaf:this.#leafUuid,
        });
        validateCommittedTranscript(restored.messages,{
          allowPendingTools:payload.kind==='tool_pending',
          allowPartialTools:payload.kind==='tool_partial',
        });
        if(payload.kind === 'tool_partial' &&
          (payload.entries.length!==1 || payload.entries[0].type!=='user' ||
           !['tool_pending','tool_partial'].includes(this.#lastKind))) {
          throw new Error('Invalid persisted partial tool-result checkpoint.');
        }
        if(payload.kind === 'tool_pending' &&
          (payload.entries.length!==1 || payload.entries[0].type!=='assistant')) {
          throw new Error('Invalid pending tool checkpoint.');
        }
        if(payload.kind === 'input' &&
          (!hasPendingUserInput(restored.messages) || payload.entries.length !== 1 ||
            payload.entries[0].type !== 'user')) {
          throw new Error('Invalid persisted first-user checkpoint.');
        }
        this.#nodes=restored.map;
        this.#leafUuid=payload.leafUuid;
        this.#messages=restored.messages;
      } else {
        throw new Error('Unsupported session transcript record version.');
      }
      this.#sequence=payload.sequence;
      this.#previousHash=hash;
      this.#lastEncoded=JSON.stringify(this.#messages);
      this.#lastKind=payload.kind;
    }
    if(!this.#sequence)throw new Error('Session has no committed messages to resume.');
    // A crash can truncate the last JSONL line. Never use that partial entry;
    // trim it under the exclusive session lock before any new append.
    if(lastLine+1 < data.length){
      await assertLockOwner(this.#lock,this.#lockToken);
      const handle=await open(this.#path,constants.O_WRONLY|NOFOLLOW);
      try{
        const before=await handle.stat();
        const atPath=await lstat(this.#path);
        if(before.dev!==readIdentity.dev || before.ino!==readIdentity.ino ||
           before.size!==readIdentity.size ||
           atPath.dev!==readIdentity.dev || atPath.ino!==readIdentity.ino ||
           atPath.size!==readIdentity.size) {
          throw new Error('Session transcript changed before torn-tail recovery.');
        }
        await handle.truncate(Buffer.byteLength(complete));
        await handle.sync();
      }finally{await handle.close();}
    }
    // Install the same file identity that produced the verified ancestry.
    // Re-statting an unrelated replacement after parse could otherwise
    // authorize the wrong on-disk file for the next model/tool checkpoint.
    const loaded=await lstat(this.#path);
    const expectedSize=Buffer.byteLength(complete);
    if(!loaded.isFile() || loaded.isSymbolicLink() ||
       loaded.dev!==readIdentity.dev || loaded.ino!==readIdentity.ino ||
       loaded.size!==expectedSize) {
      throw new Error('Session transcript changed before recovered history was adopted.');
    }
    this.#fileState={dev:loaded.dev,ino:loaded.ino,size:loaded.size};
    return this.messages;
  }
  async append({messages,kind}) {
    if(this.#closed || this.#poisoned)throw new Error('Session journal is not writable.');
    // Snapshot the queued checkpoint before another caller can mutate it.
    const checkpoint=structuredClone(messages);
    const pending=this.#writeQueue.then(()=>this.#appendCommitted({messages:checkpoint,kind}));
    // A rejected operation must not permanently strand the original write queue.
    // The individual caller still receives the real rejection.
    this.#writeQueue=pending.catch(()=>{});
    return pending;
  }
  async #appendCommitted({messages,kind}) {
    if(this.#poisoned)throw new Error('Session journal is not writable.');
    await assertLockOwner(this.#lock,this.#lockToken);
    if(!CHECKPOINT_TYPES.has(kind))throw new TypeError('Invalid session checkpoint kind.');
    validateCommittedTranscript(messages,{
      allowPendingTools:kind==='tool_pending',
      allowPartialTools:kind==='tool_partial',
    });
    if(kind === 'tool_partial' &&
       (!['tool_pending','tool_partial'].includes(this.#lastKind) ||
        messages.length!==this.#messages.length+1 ||
        JSON.stringify(messages.slice(0,-1))!==JSON.stringify(this.#messages) ||
        messages.at(-1)?.role!=='user' ||
        !Array.isArray(messages.at(-1).content) ||
        messages.at(-1).content.filter(b=>b?.type==='tool_result').length!==1)) {
      throw new Error('A partial tool checkpoint must append exactly one verified result.');
    }
    if(kind === 'tool_pending' &&
       (messages.length!==this.#messages.length+1 ||
        JSON.stringify(messages.slice(0,-1))!==JSON.stringify(this.#messages))) {
      throw new Error('A pending tool checkpoint must append exactly one assistant tool_use message.');
    }
    if(kind === 'input' && (!hasPendingUserInput(messages) ||
        messages.length !== this.#messages.length + 1 ||
        JSON.stringify(messages.slice(0,-1)) !== JSON.stringify(this.#messages))) {
      throw new Error('A pending user checkpoint must append exactly one new user prompt.');
    }
    const encoded=JSON.stringify(messages);
    if(Buffer.byteLength(encoded)>MAX_CHECKPOINT_BYTES)
      throw new RangeError('Session checkpoint exceeds 8 MiB.');
    if(encoded===this.#lastEncoded)return;
    // Source insertMessageChain() appends only new UUID-linked user/assistant
    // messages; unlike the old v1 snapshot, the journal no longer rewrites
    // or stores the entire conversation at every turn.
    const migration=!this.#leafUuid && this.#messages.length>0;
    const chain=insertMessageChain({
      messages:JSON.parse(encoded),previousMessages:this.#messages,
      previousLeaf:this.#leafUuid,sessionId:this.#id,kind,isMigration:migration,
      previousToolAssistantUuid:!migration &&
        this.#nodes.get(this.#leafUuid)?.type==='assistant'
          ? this.#leafUuid
          : (!migration ? this.#nodes.get(this.#leafUuid)?.sourceToolAssistantUUID ?? null
            : null),
    });
    if (!chain.entries.length) return;
    const validated=applyMessageChain({
      existing:this.#nodes,entries:chain.entries,
      leafUuid:chain.leafUuid,sessionId:this.#id,
      allowRoot:chain.root,previousLeaf:this.#leafUuid,
    });
    validateCommittedTranscript(validated.messages,{
      allowPendingTools:kind==='tool_pending',
      allowPartialTools:kind==='tool_partial',
    });
    if (JSON.stringify(validated.messages)!==encoded)
      throw new Error('Source parent chain reconstruction changed committed transcript.');
    const payload={
      type:'session_commit',version:2,sessionId:this.#id,
      workspace:this.#workspace,kind,
      sequence:this.#sequence+1,previousHash:this.#previousHash,
      root:chain.root, ...(migration?{migration:true}:{}),
      leafUuid:chain.leafUuid,entries:chain.entries,
    };
    const hash=digest(payload);
    const line=JSON.stringify({...payload,hash})+'\n';
    await assertLockOwner(this.#lock,this.#lockToken);
    let handle;
    let committedFile;
    try {
      handle=await open(this.#path,constants.O_WRONLY|constants.O_APPEND|NOFOLLOW);
      const before=this.#fileState?.size;
      await this.#assertTranscriptFile(handle,before);
      const nextSize=before+Buffer.byteLength(line);
      if(nextSize>MAX_JOURNAL_BYTES){
        throw new RangeError('Session journal exceeds 64 MiB.');
      }
      await handle.writeFile(line);
      await handle.sync();
      // The path must still name this exact append-only transcript after
      // fsync. A rename/recreate race is not authorization to publish a
      // checkpoint to Query or to issue another model request.
      await assertLockOwner(this.#lock,this.#lockToken);
      committedFile=await this.#assertTranscriptFile(handle,nextSize);
    }catch(error){this.#poisoned=true;throw error;}
    finally{await handle?.close();}
    this.#fileState={dev:committedFile.dev,ino:committedFile.ino,size:committedFile.size};
    this.#nodes=validated.map;
    this.#leafUuid=chain.leafUuid;
    this.#messages=validated.messages;
    this.#lastEncoded=encoded;
    this.#previousHash=hash;
    this.#lastKind=kind;
    this.#sequence++;
  }
  close() {
    if(this.#closeTask)return this.#closeTask;
    this.#closed=true;
    // Await all writes already queued when close() was requested. Otherwise
    // the owner lock could disappear during append()/fsync and poison a
    // correctly executed tool-result checkpoint.
    this.#closeTask=(async()=>{
      await this.#writeQueue;
      // Never unlink a lock belonging to a subsequent process.
      await assertLockOwner(this.#lock,this.#lockToken);
      await unlink(this.#lock);
    })();
    return this.#closeTask;
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
  const lockToken=await acquireLock(lock);
  const journal=new SessionJournal({
    path,lock,lockToken,id:sessionId,workspace:root,
  });
  try{
    if(resume)await journal.load();
    else {
      // Original session creation must not silently overwrite an existing
      // transcript or corrupt the parentUuid / checkpoint chain.
      const handle=await open(path,constants.O_CREAT|constants.O_EXCL|
        constants.O_WRONLY|NOFOLLOW,0o600);
      await handle.close();
      await journal.attachFile();
    }
    return journal;
  }catch(error){await journal.close();throw error;}
}
