import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

const input=[{role:'user',content:'Apply the change once.'}];
const use={role:'assistant',content:[{
  type:'tool_use',id:'write-once',name:'Write',
  input:{file_path:'once.txt',content:'must not replay'},
},{
  type:'tool_use',id:'read-after-write',name:'Read',input:{file_path:'once.txt'},
}]};
const result={role:'user',content:[{
  type:'tool_result',tool_use_id:'write-once',content:'done',
}]};
const lastResult={role:'user',content:[{
  type:'tool_result',tool_use_id:'read-after-write',content:'must not replay',
}]};
const summary=[{role:'user',content:'Summary: the earlier write completed. Continue from here.'}];

test('unfinished native tool batch cannot be erased by a compact root, including a partial recovered result',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-compact-fence-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:[...input,use],kind:'tool_pending'});
    await assert.rejects(journal.append({messages:summary,kind:'compact'}),
      /Cannot compact an unfinished tool batch/);
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.messages,[...input,use]);
    await journal.append({messages:[...input,use,result],kind:'tool_partial'});
    await assert.rejects(journal.append({messages:summary,kind:'compact'}),
      /Cannot compact an unfinished tool batch/);
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.messages,[...input,use,result]);
    const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input','tool_pending','tool_partial']);
    await journal.close();journal=null;
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.messages,[...input,use,result]);
    // A completed source Query tool turn is a different checkpoint:
    // only after the entire batch is finished may compact reset the root.
    await journal.append({messages:[...input,use,result,lastResult],kind:'tool'});
    await journal.append({messages:summary,kind:'compact'});
    await journal.close();journal=null;
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.messages,summary);
    assert.equal(journal.needsToolReconciliation,false);
    const final=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(final.map(x=>x.kind),[
      'input','tool_pending','tool_partial','tool','compact',
    ]);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});

test('a recomputed JSONL checksum does not permit an attacker to replace unfinished Bash with a compact root',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-forged-compact-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:[...input,use],kind:'tool_pending'});
    const path=journal.path;
    await journal.close();journal=null;
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    const previous=records.at(-1);
    const uuid=randomUUID();
    const payload={
      type:'session_commit',version:2,sessionId:id,workspace:await realpath(root),
      kind:'compact',sequence:previous.sequence+1,previousHash:previous.hash,
      root:true,leafUuid:uuid,entries:[{
        type:'user',uuid,parentUuid:null,
        logicalParentUuid:previous.leafUuid,sessionId:id,
        message:summary[0],
      }],
    };
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n'+
      JSON.stringify({...payload,hash})+'\n');
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Cannot compact an unfinished tool batch/);
    // Restore committed witness and check the original tool side effects
    // are still fenced, not silently turned into a new user prompt.
    await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.messages,[...input,use]);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
