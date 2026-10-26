import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, appendFile, symlink, mkdir, writeFile, stat, realpath, rename, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { query, ModelProtocolError } from '../src/legacy-query/query.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  openSessionJournal, validateCommittedTranscript, hasPendingToolResponse,
  hasPendingUserInput,
} from '../src/legacy-session/session-storage.js';
import { buildConversationChain } from '../src/legacy-session/native-transcript-chain.js';

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
    onSessionCheckpoint:async({kind})=>{
      // The assistant tool_use precheckpoint must succeed; only the later
      // tool_result fsync fails after the side-effecting tool ran.
      if(kind==='tool')throw new Error('ENOSPC: journal fsync unavailable');
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


test('source enqueueWrite serializes overlapping tool checkpoints and preserves the incremental UUID chain',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const finished=[...transcript,{role:'assistant',
      content:[{type:'text',text:'done after concurrent tool commit'}]}];
    // Parallel callers previously saw identical sequence/previousHash and
    // appended duplicate or divergent records, corrupting later --resume.
    await Promise.all(Array.from({length:8},()=>journal.append({
      messages:transcript,kind:'tool',
    })));
    await Promise.all([
      journal.append({messages:finished,kind:'finished'}),
      journal.append({messages:finished,kind:'finished'}),
    ]);
    const raw=await readFile(journal.path,'utf8');
    const records=raw.trim().split('\n').map(JSON.parse);
    assert.equal(records.length,2,'duplicate queued commits should be elided');
    assert.deepEqual(records.map(x=>x.sequence),[1,2]);
    assert.equal(records[1].previousHash,records[0].hash);
    assert.equal(records[1].entries.length,1,'only new assistant delta is persisted');
    const path=journal.path;
    await journal.close();
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(resumed.messages,finished);
    assert.equal(resumed.path,path);
    await resumed.close();
  });
});

test('close drains a pending original-style write before releasing the session owner lock',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const pending=journal.append({messages:transcript,kind:'tool'});
    const closing=journal.close();
    // Both completed checkpoint and lock cleanup must be durable even when
    // callers invoke close() in the same microtask as their final append().
    await Promise.all([pending,closing,journal.close()]);
    await assert.rejects(journal.append({messages:transcript,kind:'tool'}),
      /not writable/);
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(resumed.messages,transcript);
    assert.equal(resumed.canContinueWithoutPrompt,true);
    await resumed.close();
  });
});


test('original first user message persists before SSE, survives restart, and cannot masquerade as a tool batch',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const prompt='Preserved before an unsuccessful first model request';
    const input=[{role:'user',content:prompt}];
    assert.equal(hasPendingUserInput(input),true);
    assert.equal(hasPendingUserInput(transcript),false,
      'tool_result arrays must never count as an unanswered new prompt');
    await journal.append({messages:input,kind:'input'});
    assert.equal(journal.canContinueWithoutPrompt,true);
    const file=journal.path;
    await journal.close();
    const first=JSON.parse((await readFile(file,'utf8')).trim());
    assert.equal(first.kind,'input');
    assert.equal(first.entries.length,1);
    assert.equal(first.entries[0].parentUuid,null);
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(resumed.messages,input);
    assert.equal(resumed.canContinueWithoutPrompt,true);
    const finished=[...input,{role:'assistant',content:[{type:'text',text:'continued'}]}];
    await resumed.append({messages:finished,kind:'finished'});
    assert.equal(resumed.canContinueWithoutPrompt,false);
    await resumed.close();
    const again=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(again.messages,finished);
    assert.equal(again.canContinueWithoutPrompt,false);
    await again.close();
    const records=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input','finished']);
    assert.equal(records[1].entries[0].parentUuid,records[0].leafUuid);
  });
});

test('input checkpoint refuses fabricated result blocks and preexisting transcript rewrites',async()=>{
  await workspace(async root=>{
    const journal=await openSessionJournal({workspace:root,sessionId:randomUUID()});
    try {
      await assert.rejects(journal.append({
        messages:transcript,kind:'input',
      }),/exactly one new user prompt/);
      await journal.append({messages:[{role:'user',content:'first'}],kind:'input'});
      await assert.rejects(journal.append({messages:[
        {role:'user',content:'rewritten'},
        {role:'user',content:'second'},
      ],kind:'input'}),/exactly one new user prompt/);
      await assert.rejects(journal.append({
        messages:[{role:'user',content:'first'},
          {role:'user',content:[{type:'tool_result',tool_use_id:'orphan',content:'x'}]}],
        kind:'input',
      }),/no matching unfinished tool_use/);
      const lines=(await readFile(journal.path,'utf8')).trim().split('\n');
      assert.equal(lines.length,1,'failed checks must not write checkpoints');
      assert.deepEqual(journal.messages,[{role:'user',content:'first'}]);
    }finally{await journal.close();}
  });
});



test('source recoverOrphanedParallelToolResults preserves both off-chain sibling results and assistant content blocks',()=>{
  const sessionId=randomUUID(),userId=randomUUID(),aId=randomUUID(),bId=randomUUID();
  const resultAId=randomUUID(),resultBId=randomUUID();
  const base={type:'user',uuid:userId,parentUuid:null,sessionId,
    message:{role:'user',content:'Run both tools'}};
  const a={type:'assistant',uuid:aId,parentUuid:userId,sessionId,
    message:{role:'assistant',id:'same-streamed-message',content:[{
      type:'tool_use',id:'one',name:'Read',input:{file_path:'one.txt'},
    }]}};
  const b={type:'assistant',uuid:bId,parentUuid:aId,sessionId,
    message:{role:'assistant',id:'same-streamed-message',content:[{
      type:'tool_use',id:'two',name:'Read',input:{file_path:'two.txt'},
    }]}};
  const ra={type:'user',uuid:resultAId,parentUuid:aId,
    sourceToolAssistantUUID:aId,sessionId,
    message:{role:'user',content:[{
      type:'tool_result',tool_use_id:'one',content:'one completed',
    }]}};
  const rb={type:'user',uuid:resultBId,parentUuid:bId,
    sourceToolAssistantUUID:bId,sessionId,
    message:{role:'user',content:[{
      type:'tool_result',tool_use_id:'two',content:'two completed',
    }]}};
  const nodes=new Map([base,a,b,ra,rb].map(node=>[node.uuid,node]));
  const rebuilt=buildConversationChain(nodes,resultBId);
  assert.deepEqual(rebuilt.map(m=>m.role),['user','assistant','assistant','user','user']);
  assert.deepEqual(rebuilt.filter(m=>m.role==='user')
    .flatMap(m=>Array.isArray(m.content)?m.content:[])
    .filter(b=>b.type==='tool_result').map(b=>b.tool_use_id),['one','two']);
  assert.doesNotThrow(()=>validateCommittedTranscript(rebuilt));
  // The old post-pass does not accidentally attach a sibling from a
  // different session, even when it has the same provider message ID.
  const forged={...b,uuid:randomUUID(),sessionId:randomUUID()};
  nodes.set(forged.uuid,forged);
  assert.deepEqual(buildConversationChain(nodes,resultBId),rebuilt);
});

test('active SessionJournal reload recovers sibling results from old-source parentUUID fork and can continue without replay',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Read both files'}];
    const pending=[...input,{role:'assistant',id:'parallel-turn',content:[
      {type:'tool_use',id:'read-one',name:'Read',input:{file_path:'one'}},
      {type:'tool_use',id:'read-two',name:'Read',input:{file_path:'two'}},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    const file=journal.path;
    await journal.close();
    const source=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    const prior=source.at(-1),assistantUuid=prior.leafUuid;
    const makeResult=(uuid,toolUseId)=>({
      type:'user',uuid,parentUuid:assistantUuid,
      sourceToolAssistantUUID:assistantUuid,sessionId:id,
      message:{role:'user',content:[{
        type:'tool_result',tool_use_id:toolUseId,content:'result:'+toolUseId,
      }]},
    });
    const one=makeResult(randomUUID(),'read-one');
    const two=makeResult(randomUUID(),'read-two');
    const payload={type:'session_commit',version:2,sessionId:id,
      workspace:await realpath(root),kind:'tool',
      sequence:prior.sequence+1,previousHash:prior.hash,
      root:false,leafUuid:two.uuid,entries:[one,two],
    };
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await appendFile(file,JSON.stringify({...payload,hash})+'\n');
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(resumed.needsToolReconciliation,false);
    assert.equal(resumed.canContinueWithoutPrompt,true);
    assert.deepEqual(resumed.messages.slice(2).map(m=>m.content[0].tool_use_id),
      ['read-one','read-two'],'do not drop first completed result on resume');
    const finished=[...resumed.messages,
      {role:'assistant',content:[{type:'text',text:'Both read results are visible'}]}];
    await resumed.append({messages:finished,kind:'finished'});
    await resumed.close();
    const again=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(again.messages,finished);
    assert.equal(again.canContinueWithoutPrompt,false);
    await again.close();
  });
});


test('source enqueueWrite saves first parallel tool_result before next completes and retains it across restart',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Run two Write operations'}];
    const pending=[...input,{role:'assistant',content:[
      {type:'tool_use',id:'first-write',name:'Write',input:{file_path:'one',content:'one'}},
      {type:'tool_use',id:'second-write',name:'Write',input:{file_path:'two',content:'two'}},
    ]}];
    const first=[...pending,{role:'user',content:[
      {type:'tool_result',tool_use_id:'first-write',content:'first side effect succeeded'},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await journal.append({messages:first,kind:'tool_partial'});
    assert.equal(journal.needsToolReconciliation,true);
    assert.equal(journal.canContinueWithoutPrompt,false);
    assert.deepEqual(journal.messages,first);
    const path=journal.path;
    await journal.close();
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input','tool_pending','tool_partial']);
    assert.equal(records[2].entries.length,1);
    assert.equal(records[2].entries[0].sourceToolAssistantUUID,records[1].leafUuid);
    assert.equal(records[2].entries[0].parentUuid,records[1].leafUuid);
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(resumed.needsToolReconciliation,true);
    assert.deepEqual(resumed.messages,first);
    const complete=[...first,{role:'user',content:[
      {type:'tool_result',tool_use_id:'second-write',content:'second succeeded'},
    ]}];
    await resumed.append({messages:complete,kind:'tool'});
    assert.equal(resumed.needsToolReconciliation,false);
    assert.equal(resumed.canContinueWithoutPrompt,true);
    const done=[...complete,{role:'assistant',content:[{type:'text',text:'all done'}]}];
    await resumed.append({messages:done,kind:'finished'});
    await resumed.close();
    const roundTrip=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(roundTrip.messages,done);
    await roundTrip.close();
    const final=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(final.map(x=>x.kind),
      ['input','tool_pending','tool_partial','tool','finished']);
    assert.equal(final[3].entries[0].sourceToolAssistantUUID,records[1].leafUuid);
    assert.equal(final[3].entries[0].parentUuid,records[1].leafUuid);
  });
});



test('original Query preserves the last completed tool result when Hook or native context normalization fails',async()=>{
  for(const mode of ['hook','native']){
    await workspace(async root=>{
      const id=randomUUID();
      const journal=await openSessionJournal({workspace:root,sessionId:id});
      const input=[{role:'user',content:'execute both tools once'}];
      await journal.append({messages:input,kind:'input'});
      const tools=new ToolRegistry();
      tools.register({name:'Write',description:'Test original mapped tool result',
        execute:async()=>({written:true})});
      const executed=[];
      const options={
        messages:input,
        model:{async *stream(){
          yield {type:'tool_use',id:'first',name:'Write',input:{file:'one'}};
          yield {type:'tool_use',id:'last',name:'Write',input:{file:'two'}};
          yield {type:'message_end',stopReason:'tool_use'};
        }},
        tools,maxTurns:3,emit:()=>{},
        executeTool:async toolUse=>{
          executed.push(toolUse.id);
          return {type:'tool_result',tool_use_id:toolUse.id,
            content:'mapped output '+toolUse.id};
        },
        onSessionCheckpoint:checkpoint=>journal.append(checkpoint),
        getToolHookContext:mode==='hook'
          ? ()=>{throw new Error('Intentional Hook normalization failure');}
          : ()=>[],
        getToolNativeMessages:mode==='native'
          ? ()=>[{type:'tool_result',tool_use_id:'forged',content:'unsafe'}]
          : ()=>[],
      };
      const error=mode==='hook'?/Hook normalization failure/
        :/Original tool newMessages normalization returned invalid API blocks/;
      await assert.rejects(query(options),error);
      assert.deepEqual(executed,['first','last']);
      const records=(await readFile(journal.path,'utf8')).trim()
        .split('\n').map(JSON.parse);
      assert.deepEqual(records.map(x=>x.kind),
        ['input','tool_pending','tool_partial','tool_uncertain']);
      assert.equal(records[3].entries.length,1);
      assert.equal(records[3].entries[0].parentUuid,records[1].leafUuid);
      assert.equal(records[3].entries[0].sourceToolAssistantUUID,records[1].leafUuid);
      assert.deepEqual(journal.messages.slice(2).map(m=>m.content[0].tool_use_id),
        ['first','last'],'the final output must survive even when Hook context fails');
      assert.equal(journal.needsToolContextReview,true);
      assert.equal(journal.needsToolReconciliation,true);
      assert.equal(journal.canContinueWithoutPrompt,false);
      const finished=[...journal.messages,
        {role:'assistant',content:[{type:'text',text:'untrusted continuation'}]}];
      await assert.rejects(journal.append({messages:finished,kind:'finished'}),
        /continuation is fenced/);
      const file=journal.path;
      await journal.close();
      const reopened=await openSessionJournal({
        workspace:root,sessionId:id,resume:true,
      });
      assert.deepEqual(reopened.messages.slice(2).map(m=>m.content[0].tool_use_id),
        ['first','last']);
      assert.equal(reopened.needsToolContextReview,true);
      assert.equal(reopened.canContinueWithoutPrompt,false);
      await reopened.close();
      assert.equal((await readFile(file,'utf8')).trim().split('\n').length,4);
    });
  }
});


test('real AgentLoop invokes original PostToolUse after Write, and a corrupted Hook attachment preserves result with review fence', {
  timeout:25000,
},async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Write the file exactly once'}];
    await journal.append({messages:input,kind:'input'});
    await writeFile(join(root,'posthook.cjs'),
      "let body='';process.stdin.on('data',c=>body+=c);"+
      "process.stdin.on('end',()=>{"+
      "const data=JSON.parse(body);"+
      "require('node:fs').writeFileSync('hook-observed.txt',data.tool_use_id);"+
      "console.log(JSON.stringify({hookSpecificOutput:{"+
      "hookEventName:'PostToolUse',additionalContext:'posthook completed'}}));});");
    const tools=new ToolRegistry();
    let writes=0,rounds=0,hookUpdates=0;
    tools.register({
      name:'Write',description:'Write test file through original tool.call',
      call:async()=>{
        writes++;
        await writeFile(join(root,'saved.txt'),'written once');
        return {data:'file was written'};
      },
      mapToolResultToToolResultBlockParam:(data,id)=>({
        type:'tool_result',tool_use_id:id,content:data,
      }),
    });
    const loop=new AgentLoop({
      tools,maxTurns:3,
      permissionPolicy:async()=>({behavior:'allow'}),
      hookWorkspace:root,
      postToolUseHooks:[{
        type:'command',command:'node posthook.cjs',timeout:7,matcher:'Write',
      }],
      onSessionCheckpoint:checkpoint=>journal.append(checkpoint),
      onMappedToolResult:result=>journal.appendMappedToolResult(result),
      onToolExecutionStart:result=>journal.appendToolExecutionStart(result),
      model:{async *stream(){
        rounds++;
        yield {type:'tool_use',id:'write-with-hook',name:'Write',
          input:{file_path:'saved.txt',content:'written once'}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
    });
    // Fault injected *after* the authentic original PostToolUse command ran,
    // at the event-to-provider normalization boundary. No fake tool result
    // or synthetic skip of permissions/tool.call is involved.
    loop.on('hookMessage',event=>{
      if(event.message?.attachment?.type==='hook_additional_context') {
        hookUpdates++;
        event.message.attachment.content=[42];
      }
    });
    await assert.rejects(loop.run({input:input[0].content}),
      /Malformed Hook additional context/);
    assert.equal(writes,1);
    assert.equal(rounds,1,'no second model request after context failure');
    assert.equal(hookUpdates,1);
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),'written once');
    assert.equal(await readFile(join(root,'hook-observed.txt'),'utf8'),
      'write-with-hook');
    assert.equal(journal.needsToolContextReview,true);
    assert.deepEqual(journal.messages.at(-1).content.map(b=>b.tool_use_id),
      ['write-with-hook']);
    const log=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(log.map(x=>x.kind),
      ['input','tool_pending','tool_started','tool_mapped','tool_uncertain']);
    assert.equal(log[2].toolUseId,'write-with-hook');
    assert.equal(log[2].status,'executing');
    assert.equal(log[3].mappedResult.tool_use_id,'write-with-hook');
    assert.equal(log[3].assistantUuid,log[1].leafUuid);
    await journal.close();
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(resumed.needsToolReconciliation,true);
    assert.deepEqual(resumed.messages.at(-1).content[0],{
      type:'tool_result',tool_use_id:'write-with-hook',content:'file was written',
    });
    await resumed.close();
  });
});

test('tool_uncertain cannot be forged from a pending incomplete tool or followed by a forged status transition',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'two tools'}];
    const pending=[...input,{role:'assistant',content:[
      {type:'tool_use',id:'a',name:'Write',input:{}},
      {type:'tool_use',id:'b',name:'Write',input:{}},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await assert.rejects(journal.append({messages:pending,kind:'tool_uncertain'}),
      /fully paired|Incomplete tool batch/);
    const complete=[...pending,{role:'user',content:[
      {type:'tool_result',tool_use_id:'a',content:'a'},
      {type:'tool_result',tool_use_id:'b',content:'b'},
    ]}];
    await journal.append({messages:complete,kind:'tool_uncertain'});
    const path=journal.path;
    await journal.close();
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).kind,'tool_uncertain');
    const fake={type:'assistant',uuid:randomUUID(),parentUuid:records.at(-1).leafUuid,
      sessionId:id,message:{role:'assistant',content:[{type:'text',text:'forged final'}]}};
    const prior=records.at(-1);
    const payload={type:'session_commit',version:2,sessionId:id,
      workspace:await realpath(root),kind:'finished',
      sequence:prior.sequence+1,previousHash:prior.hash,
      root:false,leafUuid:fake.uuid,entries:[fake]};
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await appendFile(path,JSON.stringify({...payload,hash})+'\n');
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /continuation is fenced/);
    await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(reopened.needsToolContextReview,true);
    await reopened.close();
  });
});


test('2.1.88 pre-PostToolUse mapped result evidence is durable but never fabricates a provider message',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Run Write'}];
    const pending=[...input,{role:'assistant',content:[{
      type:'tool_use',id:'mapped-write',name:'Write',
      input:{file_path:'saved.txt',content:'saved'},
    }]}];
    const mapped={type:'tool_result',tool_use_id:'mapped-write',
      content:'the real mapped tool output'};
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await journal.appendMappedToolResult({mappedResult:mapped});
    assert.deepEqual(journal.messages,pending,
      'pre-Hook mapped witness must not become a fabricated tool_result message');
    assert.equal(journal.canContinueWithoutPrompt,false);
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.mappedToolResults.map(x=>x.mappedResult),[mapped]);
    await assert.rejects(journal.appendMappedToolResult({mappedResult:mapped}),
      /already durably staged/);
    const path=journal.path;
    await journal.close();
    const lines=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(x=>x.kind),['input','tool_pending','tool_mapped']);
    assert.equal(lines[2].type,'session_mapped_result');
    assert.equal(lines[2].assistantUuid,lines[1].leafUuid);
    assert.equal(lines[2].leafUuid,lines[1].leafUuid);
    assert.equal(lines[2].sequence,3);
    assert.equal(lines[2].previousHash,lines[1].hash);
    assert.equal(lines[2].mappedResult.content,mapped.content);
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(resumed.messages,pending);
    assert.deepEqual(resumed.mappedToolResults.map(x=>x.mappedResult),[mapped]);
    const completed=[...pending,{role:'user',content:[mapped]}];
    await resumed.append({messages:completed,kind:'tool'});
    assert.deepEqual(resumed.mappedToolResults,[]);
    assert.equal(resumed.canContinueWithoutPrompt,true);
    await resumed.close();
    const latest=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(latest.messages,completed);
    assert.deepEqual(latest.mappedToolResults,[]);
    assert.equal(latest.canContinueWithoutPrompt,true);
    await latest.close();
  });
});

test('mapped result must belong to pending assistant and tampered checksum-valid evidence is rejected on load',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Write'}];
    const pending=[...input,{role:'assistant',content:[{
      type:'tool_use',id:'source-tool',name:'Write',input:{},
    }]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    const mapped={type:'tool_result',tool_use_id:'source-tool',content:'saved'};
    await journal.appendMappedToolResult({mappedResult:mapped});
    const path=journal.path;
    await journal.close();
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    const rewrite=async fn=>{
      const altered=structuredClone(records);
      fn(altered.at(-1));
      const last=altered.at(-1);
      const {hash:oldHash,...payload}=last;
      last.hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      await writeFile(path,altered.map(x=>JSON.stringify(x)).join('\n')+'\n');
      await assert.rejects(openSessionJournal({
        workspace:root,sessionId:id,resume:true,
      }),/Invalid mapped tool result|does not belong/);
    };
    await rewrite(last=>{last.assistantUuid=randomUUID();});
    await rewrite(last=>{last.mappedResult.tool_use_id='forged-tool';});
    await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const valid=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(valid.mappedToolResults.length,1);
    await valid.close();
  });
});


test('mapped-result witness validation or fsync failure permanently fences a side-effected tool turn',async()=>{
  for(const bad of [
    {type:'tool_result',tool_use_id:'wrong',content:'forged'},
    {type:'tool_result',tool_use_id:'right',content:{not:'serializable content'}},
  ]) {
    await workspace(async root=>{
      const journal=await openSessionJournal({workspace:root,sessionId:randomUUID()});
      const input=[{role:'user',content:'Write the file'}];
      const pending=[...input,{role:'assistant',content:[{
        type:'tool_use',id:'right',name:'Write',input:{},
      }]}];
      await journal.append({messages:input,kind:'input'});
      await journal.append({messages:pending,kind:'tool_pending'});
      await assert.rejects(journal.appendMappedToolResult({mappedResult:bad}),
        /does not belong|complete authenticated result/);
      await assert.rejects(journal.appendMappedToolResult({mappedResult:{
        type:'tool_result',tool_use_id:'right',content:'actual side effect',
      }}),/not writable/);
      const completed=[...pending,{role:'user',content:[{
        type:'tool_result',tool_use_id:'right',content:'write succeeded',
      }]}];
      await assert.rejects(journal.append({messages:completed,kind:'tool'}),
        /not writable/,'original Query must never continue after staging failure');
      assert.deepEqual(journal.messages,pending);
      await journal.close();
      const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.map(record=>record.kind),['input','tool_pending']);
    });
  }
});


test('real serial AgentLoop does not execute a later Write if the first pre-Hook durable witness fails',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Run two Writes'}];
    await journal.append({messages:input,kind:'input'});
    const tools=new ToolRegistry();
    const writes=[];
    tools.register({
      name:'Write',description:'Source serial Write',
      call:async ({name})=>{
        writes.push(name);
        await writeFile(join(root,name+'.txt'),name);
        return {data:'written '+name};
      },
      mapToolResultToToolResultBlockParam:(data,id)=>({
        type:'tool_result',tool_use_id:id,content:data,
      }),
    });
    let requests=0;
    const loop=new AgentLoop({
      tools,maxTurns:3,permissionPolicy:async()=>({behavior:'allow'}),
      hookWorkspace:root,postToolUseHooks:[{
        type:'command',command:'node -e "process.exit(0)"',
        timeout:5,matcher:'Write',
      }],
      onSessionCheckpoint:x=>journal.append(x),
      onMappedToolResult:({mappedResult})=>
        journal.appendMappedToolResult({
          mappedResult:{...mappedResult,tool_use_id:'forged-result'},
        }),
      model:{async *stream(){
        requests++;
        yield {type:'tool_use',id:'first-tool',name:'Write',
          input:{name:'first'}};
        yield {type:'tool_use',id:'second-tool',name:'Write',
          input:{name:'second'}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
    });
    await assert.rejects(loop.run({input:input[0].content}),
      /not writable|does not belong/);
    assert.deepEqual(writes,['first'],
      'serial original executor must refuse second side effect after journaling failure');
    assert.equal(requests,1,'no subsequent provider round');
    assert.equal(await readFile(join(root,'first.txt'),'utf8'),'first');
    await assert.rejects(readFile(join(root,'second.txt'),'utf8'),{code:'ENOENT'});
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.messages.slice(0,1),input);
    await assert.rejects(journal.append({messages:[...journal.messages,{
      role:'user',content:[{
        type:'tool_result',tool_use_id:'first-tool',content:'forged',
      }],
    }],kind:'tool'}),/not writable/);
    await journal.close();
  });
});


test('original executor executing status is durable before Tool.call, remains uncompleted after restart',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Write one file'}];
    const pending=[...input,{role:'assistant',content:[
      {type:'tool_use',id:'first-tool',name:'Write',input:{}},
      {type:'tool_use',id:'second-tool',name:'Write',input:{}},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await journal.appendToolExecutionStart({
      toolUseId:'first-tool',toolName:'Write',
    });
    assert.deepEqual(journal.startedToolExecutions.map(x=>x.toolUseId),
      ['first-tool']);
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.messages,pending,
      'an executing tool is NOT an already completed provider tool_result');
    await assert.rejects(journal.appendToolExecutionStart({
      toolUseId:'first-tool',toolName:'Write',
    }),/already started/);
    await assert.rejects(journal.appendToolExecutionStart({
      toolUseId:'second-tool',toolName:'Write',
    }),/not writable/,
      'failed status transitions fence the journal instead of allowing re-execution');
    const path=journal.path;
    await journal.close();
    const lines=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(x=>x.kind),
      ['input','tool_pending','tool_started']);
    assert.equal(lines[2].status,'executing');
    assert.equal(lines[2].assistantUuid,lines[1].leafUuid);
    assert.equal(lines[2].leafUuid,lines[1].leafUuid);
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(reopened.needsToolReconciliation,true);
    assert.deepEqual(reopened.startedToolExecutions.map(x=>x.toolUseId),['first-tool']);
    assert.deepEqual(reopened.messages,pending);
    await reopened.close();
  });
});

test('checksum-valid forged executing status cannot impersonate another tool or earlier assistant',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Write'}];
    const pending=[...input,{role:'assistant',content:[{
      type:'tool_use',id:'expected-tool',name:'Write',input:{},
    }]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await journal.appendToolExecutionStart({toolUseId:'expected-tool',toolName:'Write'});
    const path=journal.path;
    await journal.close();
    const lines=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    for(const modify of [
      last=>{last.toolUseId='other-tool';},
      last=>{last.toolName='Bash';},
      last=>{last.assistantUuid=randomUUID();},
      last=>{last.status='completed';},
    ]){
      const forged=structuredClone(lines);
      modify(forged.at(-1));
      const {hash:oldHash,...payload}=forged.at(-1);
      forged.at(-1).hash=createHash('sha256')
        .update(JSON.stringify(payload)).digest('hex');
      await writeFile(path,forged.map(x=>JSON.stringify(x)).join('\n')+'\n');
      await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
        /Invalid tool execution witness|does not match committed assistant tool_use/);
    }
    await writeFile(path,lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(resumed.startedToolExecutions[0].toolUseId,'expected-tool');
    await resumed.close();
  });
});

test('real SIGKILL inside Tool.call retains executing witness with no fabricated mapped result', {
  timeout:35000,
},async()=>{
  await workspace(async root=>{
    const id=randomUUID(),script=join(root,'call-hanging.mjs');
    const agentUrl=new URL('../src/agent-loop.js',import.meta.url).href;
    const toolsUrl=new URL('../src/tool-registry.js',import.meta.url).href;
    const journalUrl=new URL('../src/legacy-session/session-storage.js',import.meta.url).href;
    await writeFile(script,`
import {writeFileSync} from 'node:fs';
import {AgentLoop} from ${JSON.stringify(agentUrl)};
import {ToolRegistry} from ${JSON.stringify(toolsUrl)};
import {openSessionJournal} from ${JSON.stringify(journalUrl)};
const [root,id]=process.argv.slice(2);
const journal=await openSessionJournal({workspace:root,sessionId:id});
const input=[{role:'user',content:'one Write'}];
await journal.append({messages:input,kind:'input'});
const tools=new ToolRegistry();
tools.register({
  name:'Write',description:'Simulated side-effecting original Tool.call',
  call:async()=>{
    writeFileSync(root+'/tool-side-effect.txt','side effect already happened');
    await new Promise(()=>{});
  },
  mapToolResultToToolResultBlockParam:(data,toolUseId)=>({
    type:'tool_result',tool_use_id:toolUseId,content:data,
  }),
});
const loop=new AgentLoop({
  tools,maxTurns:2,
  permissionPolicy:async()=>({behavior:'allow'}),
  onSessionCheckpoint:x=>journal.append(x),
  onToolExecutionStart:x=>journal.appendToolExecutionStart(x),
  model:{async *stream(){
    yield {type:'tool_use',id:'write-in-progress',name:'Write',input:{}};
    yield {type:'message_end',stopReason:'tool_use'};
  }},
});
await loop.run({input:'one Write'});
`);
    const child=spawn(process.execPath,[script,root,id],{
      cwd:root,stdio:['ignore','pipe','pipe'],
    });
    const errors=[];
    child.stderr.on('data',b=>errors.push(b));
    child.stdout.resume();
    const closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    try{
      let observed=false;
      for(let n=0;n<240;n++){
        try{
          observed=(await readFile(join(root,'tool-side-effect.txt'),'utf8'))===
            'side effect already happened';
          if(observed)break;
        }catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,35));
      }
      assert.equal(observed,true,Buffer.concat(errors).toString('utf8'));
      child.kill('SIGKILL');
      await closed;
      const journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
      assert.equal(journal.needsToolReconciliation,true);
      assert.equal(journal.canContinueWithoutPrompt,false);
      assert.deepEqual(journal.startedToolExecutions.map(x=>x.toolUseId),
        ['write-in-progress']);
      assert.deepEqual(journal.mappedToolResults,[],
        'Tool.call never returned, so a successful result must not be fabricated');
      assert.deepEqual(journal.messages.map(x=>x.role),['user','assistant']);
      const lines=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(lines.map(x=>x.kind),
        ['input','tool_pending','tool_started']);
      assert.equal(lines[2].toolName,'Write');
      assert.equal(lines[2].status,'executing');
      assert.equal(lines[2].assistantUuid,lines[1].leafUuid);
      await journal.close();
    }finally{
      if(child.exitCode===null)child.kill('SIGKILL');
      await closed;
    }
  });
});

test('source strictOrderedResults refuses a future sibling as the first durable partial result',async()=>{
  await workspace(async root=>{
    const journal=await openSessionJournal({workspace:root,sessionId:randomUUID()});
    try{
      const input=[{role:'user',content:'run 3 calls in model order'}];
      const pending=[...input,{role:'assistant',content:[
        {type:'tool_use',id:'one',name:'Write',input:{}},
        {type:'tool_use',id:'two',name:'Write',input:{}},
        {type:'tool_use',id:'three',name:'Write',input:{}},
      ]}];
      await journal.append({messages:input,kind:'input'});
      await journal.append({messages:pending,kind:'tool_pending'});
      const outOfOrder=[...pending,{role:'user',content:[
        {type:'tool_result',tool_use_id:'two',content:'second finished first'},
      ]}];
      await assert.rejects(journal.append({
        messages:outOfOrder,kind:'tool_partial',
      }),/ordered prefix/);
      const first=[...pending,{role:'user',content:[
        {type:'tool_result',tool_use_id:'one',content:'first'},
      ]}];
      await journal.append({messages:first,kind:'tool_partial'});
      const skipped=[...first,{role:'user',content:[
        {type:'tool_result',tool_use_id:'three',content:'third'},
      ]}];
      await assert.rejects(journal.append({
        messages:skipped,kind:'tool_partial',
      }),/ordered prefix/);
      assert.deepEqual(journal.messages,first);
      assert.equal(journal.needsToolReconciliation,true);
      const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.map(x=>x.kind),['input','tool_pending','tool_partial']);
    }finally{await journal.close();}
  });
});

test('checksum-valid tool_partial must respect the executor tool-use order on reload',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'two tools'}];
    const pending=[...input,{role:'assistant',content:[
      {type:'tool_use',id:'first',name:'Write',input:{}},
      {type:'tool_use',id:'second',name:'Write',input:{}},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    const path=journal.path;
    await journal.close();
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    const previous=records.at(-1);
    const wrong={type:'user',uuid:randomUUID(),parentUuid:previous.leafUuid,
      sourceToolAssistantUUID:previous.leafUuid,sessionId:id,
      message:{role:'user',content:[
        {type:'tool_result',tool_use_id:'second',content:'wrong result order'},
      ]}};
    const payload={type:'session_commit',version:2,sessionId:id,
      workspace:await realpath(root),kind:'tool_partial',
      sequence:previous.sequence+1,previousHash:previous.hash,
      root:false,leafUuid:wrong.uuid,entries:[wrong]};
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await appendFile(path,JSON.stringify({...payload,hash})+'\n');
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /ordered prefix/);
    // The original valid source leaves are still available if the forged
    // extra commit is removed; reloading must not silently accept it.
    await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(resumed.needsToolReconciliation,true);
    assert.deepEqual(resumed.messages,pending);
    await resumed.close();
  });
});

test('partial tool checkpoint rejects forged, missing, duplicate and complete-batch checkpoint states',async()=>{
  await workspace(async root=>{
    const journal=await openSessionJournal({workspace:root,sessionId:randomUUID()});
    try{
      const input=[{role:'user',content:'run both'}];
      const pending=[...input,{role:'assistant',content:[
        {type:'tool_use',id:'tool-one',name:'Write',input:{}},
        {type:'tool_use',id:'tool-two',name:'Write',input:{}},
      ]}];
      await journal.append({messages:input,kind:'input'});
      await journal.append({messages:pending,kind:'tool_pending'});
      const partial=[...pending,{role:'user',content:[
        {type:'tool_result',tool_use_id:'tool-one',content:'one'},
      ]}];
      await journal.append({messages:partial,kind:'tool_partial'});
      const forged=[...partial,{role:'user',content:[
        {type:'tool_result',tool_use_id:'not-requested',content:'bad'},
      ]}];
      await assert.rejects(journal.append({messages:forged,kind:'tool_partial'}),
        /no matching unfinished tool_use/);
      const duplicate=[...partial,{role:'user',content:[
        {type:'tool_result',tool_use_id:'tool-one',content:'duplicate'},
      ]}];
      await assert.rejects(journal.append({messages:duplicate,kind:'tool_partial'}),
        /no matching unfinished tool_use/);
      const complete=[...partial,{role:'user',content:[
        {type:'tool_result',tool_use_id:'tool-two',content:'two'},
      ]}];
      await assert.rejects(journal.append({messages:complete,kind:'tool_partial'}),
        /Partial tool checkpoint/);
      assert.deepEqual(journal.messages,partial);
      assert.equal((await readFile(journal.path,'utf8')).trim().split('\n').length,3);
    }finally{await journal.close();}
  });
});

test('original assistant tool_use commits before results and blocks unsafe promptless replay after restart',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'write the requested file'}];
    const pending=[...input,{role:'assistant',content:[{
      type:'tool_use',id:'pending-on-crash',name:'Write',
      input:{file_path:'checked.txt',content:'side effect may have occurred'},
    }]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    assert.equal(journal.needsToolReconciliation,true);
    assert.equal(journal.canContinueWithoutPrompt,false);
    const raw=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(raw.map(x=>x.kind),['input','tool_pending']);
    assert.equal(raw[1].entries[0].parentUuid,raw[0].leafUuid);
    await journal.close();
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(reopened.needsToolReconciliation,true);
    assert.deepEqual(reopened.messages,pending);
    const completed=[...pending,{role:'user',content:[{
      type:'tool_result',tool_use_id:'pending-on-crash',content:'write succeeded',
    }]}];
    await reopened.append({messages:completed,kind:'tool'});
    assert.equal(reopened.needsToolReconciliation,false);
    assert.equal(reopened.canContinueWithoutPrompt,true);
    await reopened.close();
    const again=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(again.messages,completed);
    const records=(await readFile(again.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records[2].entries.length,1);
    assert.equal(records[2].entries[0].sourceToolAssistantUUID,records[1].leafUuid);
    assert.equal(records[2].entries[0].parentUuid,records[1].leafUuid);
    await again.close();
  });
});

test('pending tool source checkpoint rejects non-tool assistant, rewrites, and forged tool associations',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'run'}];
    await journal.append({messages:input,kind:'input'});
    await assert.rejects(journal.append({messages:[...input,
      {role:'assistant',content:[{type:'text',text:'not a tool'}]}],
      kind:'tool_pending'}),/requires one complete assistant tool_use batch/);
    await assert.rejects(journal.append({messages:[
      {role:'user',content:'rewritten'},
      {role:'assistant',content:[{type:'tool_use',id:'other',name:'Write',input:{}}]},
    ],kind:'tool_pending'}),/must append exactly one assistant tool_use/);
    await journal.append({messages:[...input,
      {role:'assistant',content:[{type:'tool_use',id:'original',name:'Write',input:{}}]}],
      kind:'tool_pending'});
    await assert.rejects(journal.append({messages:[...input,
      {role:'assistant',content:[{type:'tool_use',id:'original',name:'Write',input:{}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'forged',content:'bad'}]}],
      kind:'tool'}),/no matching unfinished tool_use/);
    await journal.close();
    const resumed=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(resumed.needsToolReconciliation,true);
    await resumed.close();
  });
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


test('2.1.304 write fence rejects same-sized external transcript replacement and keeps result ancestry intact',async()=>{
  await workspace(async root=>{
    const id=randomUUID();
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:transcript,kind:'tool'});
    const before=await readFile(journal.path,'utf8');
    const displaced=journal.path+'.displaced';
    await rename(journal.path,displaced);
    await writeFile(journal.path,before);
    const completed=[...transcript,
      {role:'assistant',content:[{type:'text',text:'must not append'}]}];
    await assert.rejects(journal.append({messages:completed,kind:'finished'}),
      /writes fenced/);
    assert.equal(await readFile(journal.path,'utf8'),before,
      'replacement inode must not receive unauthorized same-sized continuation');
    await assert.rejects(journal.append({messages:completed,kind:'finished'}),
      /not writable/,'once integrity was lost, the process must remain fenced');
    assert.deepEqual(journal.messages,transcript,
      'model-visible history must not claim an uncommitted tool completion');
    await journal.close();
    await rm(journal.path);
    await rename(displaced,journal.path);
    const recovered=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(recovered.messages,transcript);
    assert.equal(recovered.canContinueWithoutPrompt,true);
    await recovered.close();
  });
});

test('2.1.304 write fence refuses an externally truncated live session journal',async()=>{
  await workspace(async root=>{
    const journal=await openSessionJournal({workspace:root,sessionId:randomUUID()});
    await journal.append({messages:transcript,kind:'tool'});
    const before=await readFile(journal.path,'utf8');
    await truncate(journal.path,Buffer.byteLength(before)-1);
    const completed=[...transcript,
      {role:'assistant',content:[{type:'text',text:'should not commit'}]}];
    await assert.rejects(journal.append({messages:completed,kind:'finished'}),
      /writes fenced/);
    assert.equal((await readFile(journal.path,'utf8')).length,before.length-1);
    await assert.rejects(journal.append({messages:completed,kind:'finished'}),
      /not writable/);
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
