import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, appendFile, symlink, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  openSessionJournal, validateCommittedTranscript, hasPendingToolResponse,
} from '../src/legacy-session/session-storage.js';

const transcript=[
  {role:'user',content:'create a file'},
  {role:'assistant',content:[{type:'tool_use',id:'write-once',name:'Write',
    input:{file_path:'saved.txt',content:'done'}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'write-once',
    content:'file was written'}]},
];
async function workspace(task) {
  const root=await mkdtemp(join(tmpdir(),'agent-cil-session-'));
  try{await task(root);}finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
test('original JSONL append preserves complete ordered tool_result and resumes latest finished checkpoint across instances',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:transcript,kind:'tool'});
    await journal.append({messages:[...transcript,
      {role:'assistant',content:[{type:'text',text:'completed'}]}],kind:'finished'});
    const file=journal.path;
    await journal.close();
    const raw=await readFile(file,'utf8');
    assert.equal(raw.trim().split('\n').length,2);
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(reopened.id,id);
    assert.deepEqual(reopened.messages[2].content[0],
      transcript[2].content[0]);
    assert.equal(reopened.messages[3].content[0].text,'completed');
    // Windows stat.mode does not encode NTFS ACLs. Only assert chmod-style
    // 0600 semantics where the POSIX mode bits are authoritative.
    if(process.platform!=='win32') {
      assert.equal((await stat(file)).mode & 0o777 & 0o077,0,
        'POSIX journal must not grant group or other read permissions');
    }
    await reopened.close();
  });
});
test('session journal persists no partial tool_use batches or forged tool_result',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    try{
      const partial=transcript.slice(0,2);
      assert.throws(()=>validateCommittedTranscript(partial),
        /Incomplete tool batch/);
      await assert.rejects(journal.append({messages:partial,kind:'tool'}),
        /Incomplete tool batch/);
      const forged=[{role:'user',content:'x'},
        {role:'user',content:[{type:'tool_result',tool_use_id:'bad',content:'forged'}]}];
      await assert.rejects(journal.append({messages:forged,kind:'tool'}),
        /no matching unfinished tool_use/);
      assert.deepEqual(journal.messages,[]);
    }finally{await journal.close();}
    const data=await readFile(join(root,'.agent-cil','sessions',id,'transcript.jsonl'),'utf8');
    assert.equal(data,'');
  });
});
test('resume ignores truncated final JSONL entry and repairs its tail before the next append',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const first=await openSessionJournal({workspace:root,sessionId:id});
    await first.append({messages:transcript,kind:'tool'});
    const file=first.path;
    await first.close();
    await appendFile(file,'{"type":"session_checkpoint", "messages":');
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(resumed.messages,transcript);
    await resumed.append({messages:[...transcript,
      {role:'assistant',content:[{type:'text',text:'resumed'}]}],
      kind:'finished'});
    await resumed.close();
    const raw=await readFile(file,'utf8');
    assert.equal(raw.trim().split('\n').length,2);
    const next=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(next.messages.at(-1).content[0].text,'resumed');
    await next.close();
  });
});
test('changed or mismatched journal checksum and workspace cannot be silently resumed',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:transcript,kind:'tool'});
    const file=journal.path;await journal.close();
    const raw=await readFile(file,'utf8');
    await writeFile(file,raw.replace('file was written','file was changed'));
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Invalid or modified session checkpoint chain/);
  });
});
test('new session cannot overwrite an existing transcript; a concurrent resume is locked',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:transcript,kind:'tool'});
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /already active/);
    await journal.close();
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id}),
      /EEXIST/);
  });
});
test('session rejects invalid IDs, symlink session directories and nonexistent resume targets',async()=>{
  await workspace(async root=>{
    await assert.rejects(openSessionJournal({workspace:root,sessionId:'../escape'}),
      /UUID/);
    await assert.rejects(openSessionJournal({
      workspace:root,sessionId:randomUUID(),resume:true,
    }),/ENOENT/);
    const external=await mkdtemp(join(tmpdir(),'agent-cil-session-external-'));
    try {
      // The root .agent-cil symlink may redirect transcripts out of the
      // explicit --cwd if not checked before mkdir/open.
      await rm(join(root,'.agent-cil'),{recursive:true,force:true});
      try{
        await symlink(external,join(root,'.agent-cil'),'dir');
      }catch(error){
        if(error.code==='EPERM')return; // Windows accounts without symlink rights
        throw error;
      }
      await assert.rejects(openSessionJournal({
        workspace:root,sessionId:randomUUID(),
      }),/not a real directory/);
    }finally{await rm(external,{recursive:true,force:true});}
  });
});

test('crashed session stale PID lock is recovered before resuming an intact checkpoint',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const previous=await openSessionJournal({workspace:root,sessionId:id});
    await previous.append({messages:transcript,kind:'tool'});
    const lock=previous.path+'.lock';
    await previous.close();
    // Simulates process death after fsync but before the shutdown finally.
    await writeFile(lock,JSON.stringify({pid:2147483000,startedAt:1}));
    const recovered=await openSessionJournal({
      workspace:root,sessionId:id,resume:true,
    });
    assert.deepEqual(recovered.messages,transcript);
    await recovered.close();
  });
});
test('failed durable checkpoint blocks the second provider round even though the tool already executed',{
  timeout:12000,
},async()=>{
  const tools=new ToolRegistry();
  let writes=0,requests=0,committedEvents=0;
  tools.register({name:'Write',description:'Durability boundary tool',
    execute:async()=>{writes++;return 'durable output';},
  });
  const loop=new AgentLoop({
    tools,permissionPolicy:async()=>({behavior:'allow'}),
    onSessionCheckpoint:async()=>{
      throw new Error('ENOSPC: journal fsync unavailable');
    },
    model:{async *stream(){
      requests++;
      yield {type:'tool_use',id:'should-not-repeat',name:'Write',input:{}};
      yield {type:'message_end',stopReason:'tool_use'};
    }},
  });
  loop.on('turnFinished',()=>committedEvents++);
  await assert.rejects(loop.run({input:'write once'}),
    /ENOSPC: journal fsync unavailable/);
  assert.equal(writes,1,'tool execution already happened before a disk failure');
  assert.equal(requests,1,'no second provider call when tool result was not durably committed');
  assert.equal(committedEvents,0,'must not publish a successfully persisted checkpoint');
  assert.equal(loop.active,false);
});

test('source Query promptless resume is restricted to a fully paired terminal tool batch', async()=>{
  assert.equal(hasPendingToolResponse(transcript),true);
  assert.equal(hasPendingToolResponse(transcript.slice(0,2)),false);
  assert.equal(hasPendingToolResponse([...transcript,{role:'assistant',
    content:[{type:'text',text:'finished'}]}]),false);
  assert.equal(hasPendingToolResponse([{role:'user',content:'start'},{
    role:'assistant',content:[{type:'tool_use',id:'a',name:'Write',input:{}},
      {type:'tool_use',id:'b',name:'Write',input:{}}]},{
    role:'user',content:[{type:'tool_result',tool_use_id:'a',content:'only one'}]}]),false);
  assert.equal(hasPendingToolResponse([{role:'user',content:'start'},{
    role:'assistant',content:[{type:'tool_use',id:'a',name:'Write',input:{}}]},{
    role:'user',content:[{type:'tool_result',tool_use_id:'a',content:'ok'},
      {type:'tool_result',tool_use_id:'a',content:'injected'}]}]),false);
  await workspace(async root=>{
    const id=randomUUID();
    const store=await openSessionJournal({workspace:root,sessionId:id});
    assert.equal(store.canContinueWithoutPrompt,false);
    await store.append({messages:transcript,kind:'tool'});
    assert.equal(store.canContinueWithoutPrompt,true);
    await store.append({messages:[...transcript,{role:'assistant',
      content:[{type:'text',text:'response already finished'}]}],kind:'finished'});
    assert.equal(store.canContinueWithoutPrompt,false);
    await store.close();
    const reloaded=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(reloaded.canContinueWithoutPrompt,false);
    await reloaded.close();
  });
});

test('existing v1 committed transcript resumes and migrates to 2.1.88-inspired UUID chain on next append',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const initial=await openSessionJournal({workspace:root,sessionId:id});
    const path=initial.path;
    await initial.close();
    const payload={
      type:'session_checkpoint',version:1,sessionId:id,
      workspace:await realpath(root),kind:'tool',sequence:1,
      previousHash:'0'.repeat(64),messages:transcript,
    };
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(path,JSON.stringify({...payload,hash})+'\n');
    const old=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(old.messages,transcript,'v1 tool result and source metadata remain intact');
    assert.equal(old.canContinueWithoutPrompt,true);
    const finished=[...transcript,{role:'assistant',
      content:[{type:'text',text:'migrated and finished'}]}];
    await old.append({messages:finished,kind:'finished'});
    await old.close();
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length,2);
    assert.equal(records[0].version,1);
    assert.equal(records[1].version,2);
    assert.equal(records[1].migration,true);
    assert.equal(records[1].entries.length,4);
    assert.equal(records[1].entries[0].parentUuid,null);
    assert.equal(records[1].entries[2].sourceToolAssistantUUID,
      records[1].entries[1].uuid);
    assert.equal(records[1].previousHash,hash);
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(reopened.messages,finished);
    await reopened.close();
  });
});
test('original compact boundary starts a new parentUuid root with logicalParentUuid linking prior leaf',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:transcript,kind:'tool'});
    const before=JSON.parse((await readFile(journal.path,'utf8')).trim());
    const compact=[
      {role:'user',content:'Context summary of earlier tool work'},
      {role:'assistant',content:[{type:'text',text:'I can continue from this summary.'}]},
    ];
    await journal.append({messages:compact,kind:'compact'});
    const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.length,2);
    assert.equal(records[1].root,true);
    assert.equal(records[1].entries[0].parentUuid,null);
    assert.equal(records[1].entries[0].logicalParentUuid,before.leafUuid);
    assert.equal(records[1].entries[1].parentUuid,records[1].entries[0].uuid);
    await journal.close();
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(reopened.messages,compact);
    assert.equal(reopened.canContinueWithoutPrompt,false);
    await reopened.close();
  });
});
test('a recomputed checksum cannot legitimize invalid parentUuid or a forged tool-result source association',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const initial=await openSessionJournal({workspace:root,sessionId:id});
    await initial.append({messages:transcript,kind:'tool'});
    const path=initial.path;
    await initial.close();
    const raw=JSON.parse((await readFile(path,'utf8')).trim());
    const manipulate=async(edited,error)=>{
      const {hash:_old,...payload}=edited;
      const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      await writeFile(path,JSON.stringify({...payload,hash})+'\n');
      await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),error);
    };
    const broken=structuredClone(raw);
    broken.entries[1].parentUuid=randomUUID();
    await manipulate(broken,/parentUuid chain is broken/);
    const forged=structuredClone(raw);
    forged.entries[2].sourceToolAssistantUUID=forged.entries[0].uuid;
    await manipulate(forged,/Invalid sourceToolAssistantUUID association/);
    await writeFile(path,JSON.stringify(raw)+'\n');
    const good=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(good.messages,transcript);
    await good.close();
  });
});

test('source compact root requires logicalParentUuid even when forged JSONL checksum is valid',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:transcript,kind:'tool'});
    const compact=[{role:'user',content:'after compact summary'},
      {role:'assistant',content:[{type:'text',text:'continued from compact'}]}];
    await journal.append({messages:compact,kind:'compact'});
    const file=journal.path;
    await journal.close();
    const records=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    const tampered=structuredClone(records.at(-1));
    delete tampered.entries[0].logicalParentUuid;
    const {hash:oldHash,...payload}=tampered;
    tampered.hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(file,JSON.stringify(records[0])+'\n'+JSON.stringify(tampered)+'\n');
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Missing logicalParentUuid compact boundary/);
  });
});
test('a non-compact append cannot silently replace earlier committed transcript messages',async()=>{
  await workspace(async root=>{
    const journal=await openSessionJournal({workspace:root,sessionId:randomUUID()});
    await journal.append({messages:transcript,kind:'tool'});
    const rewritten=structuredClone(transcript);
    rewritten[0].content='some other user prompt';
    await assert.rejects(journal.append({messages:rewritten,kind:'tool'}),
      /Non-compact session transition rewrites already committed messages/);
    assert.deepEqual(journal.messages,transcript);
    await journal.close();
  });
});

test('session storage refuses a replacement lock owner, does not append, and never deletes another owner lock',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const path=journal.path;
    await journal.append({messages:transcript,kind:'tool'});
    const previous=await readFile(path,'utf8');
    const lock=path+'.lock';
    const nextOwnerToken=randomUUID();
    // Simulates a race in which another session process has acquired the
    // lock between this process's two completed tool turns.
    await writeFile(lock,JSON.stringify({
      pid:process.pid,startedAt:Date.now(),token:nextOwnerToken,
    })+'\n');
    const finished=[...transcript,{
      role:'assistant',content:[{type:'text',text:'should not be committed'}],
    }];
    await assert.rejects(journal.append({messages:finished,kind:'finished'}),
      /lock ownership lost/);
    assert.equal(await readFile(path,'utf8'),previous,
      'a former owner must not append a forged durable checkpoint');
    assert.deepEqual(journal.messages,transcript,
      'the failed append must not publish a new local checkpoint');
    await assert.rejects(journal.close(),/lock ownership lost/);
    assert.equal(JSON.parse(await readFile(lock,'utf8')).token,nextOwnerToken,
      'the displaced process must not unlink the active owner lock');
  });
});

test('two actual Node processes cannot own the same session, but a new process resumes after release',{
  timeout:15000,
},async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const parent=await openSessionJournal({workspace:root,sessionId:id});
    await parent.append({messages:transcript,kind:'tool'});
    // Real independent Node process, not merely a second SessionJournal in
    // one V8 isolate. This is the lock boundary used by agent-cil --resume.
    const moduleUrl=new URL('../src/legacy-session/session-storage.js',import.meta.url).href;
    const js = `import {openSessionJournal} from ${JSON.stringify(moduleUrl)};
      try {
        const journal=await openSessionJournal({
          workspace:process.env.AGENT_CIL_LOCK_TEST_ROOT,
          sessionId:process.env.AGENT_CIL_LOCK_TEST_SESSION,
          resume:true,
        });
        await journal.close();
        process.stdout.write('acquired');
      } catch(error) {
        process.stderr.write(error.message);
        process.exitCode=17;
      }`;
    function runChild(){
      return spawnSync(process.execPath,['--input-type=module','--eval',js],{
        env:{...process.env,AGENT_CIL_LOCK_TEST_ROOT:root,
          AGENT_CIL_LOCK_TEST_SESSION:id},
        encoding:'utf8',timeout:10000,
      });
    }
    try {
      const blocked=runChild();
      assert.equal(blocked.status,17,blocked.stdout+blocked.stderr);
      assert.match(blocked.stderr,/already active/);
      assert.equal(blocked.stdout,'');
      assert.deepEqual(parent.messages,transcript);
    }finally {await parent.close();}
    const resumed=runChild();
    assert.equal(resumed.status,0,resumed.stdout+resumed.stderr);
    assert.equal(resumed.stdout,'acquired');
  });
});
