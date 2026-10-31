import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

const first=[{role:'user',content:'Run both tools and keep their real results.'}];
const uses={role:'assistant',content:[
  {type:'tool_use',id:'write-once',name:'Write',
    input:{file_path:'once.txt',content:'already written'}},
  {type:'tool_use',id:'read-after',name:'Read',
    input:{file_path:'once.txt'}},
]};
const r1={role:'user',content:[
  {type:'tool_result',tool_use_id:'write-once',content:'verified write'},
]};
const r2={role:'user',content:[
  {type:'tool_result',tool_use_id:'read-after',content:'already written'},
]};
const complete=[...first,uses,r1,r2];
const final={role:'assistant',content:[{type:'text',text:'Both complete.'}]};
const sha=payload=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');

test('finished cannot skip a pending or partial tool-result checkpoint; real tool+final remains resumable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-finished-tool-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:first,kind:'input'});
    await journal.append({messages:[...first,uses],kind:'tool_pending'});
    const path=journal.path;
    const before=await readFile(path,'utf8');
    await assert.rejects(journal.append({
      messages:[...complete,final],kind:'finished',
    }),/Cannot finish an unfinished tool batch/);
    assert.equal(await readFile(path,'utf8'),before);
    assert.equal(journal.needsToolReconciliation,true);

    await journal.append({messages:[...first,uses,r1],kind:'tool_partial'});
    const partial=await readFile(path,'utf8');
    await assert.rejects(journal.append({
      messages:[...complete,final],kind:'finished',
    }),/Cannot finish an unfinished tool batch/);
    assert.equal(await readFile(path,'utf8'),partial);
    assert.equal(journal.needsToolReconciliation,true);
    await journal.append({messages:complete,kind:'tool'});
    assert.equal(journal.needsToolReconciliation,false);
    await journal.append({messages:[...complete,final],kind:'finished'});
    await journal.close();journal=null;
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.messages,[...complete,final]);
    assert.equal(journal.needsToolReconciliation,false);
    assert.equal(journal.canContinueWithoutPrompt,false);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});

test('rehashed forged finished record cannot replace native tool completion after pending or partial batches',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-forged-finished-'));
  let journal;
  try{
    for(const makePartial of [false,true]){
      const id=randomUUID();
      journal=await openSessionJournal({workspace:root,sessionId:id});
      // Native insertMessageChain() requires an immediate assistant/use
      // parent for each first tool_result. A fully complete single-tool
      // batch is the genuine pending->tool route; a two-tool batch must
      // use the original pending->partial->tool sibling-result route.
      const activeUses=makePartial?uses:{
        role:'assistant',content:[uses.content[0]],
      };
      const committed=makePartial?complete:[...first,activeUses,r1];
      await journal.append({messages:first,kind:'input'});
      await journal.append({messages:[...first,activeUses],kind:'tool_pending'});
      if(makePartial)
        await journal.append({messages:[...first,activeUses,r1],kind:'tool_partial'});
      await journal.append({messages:committed,kind:'tool'});
      const path=journal.path;
      await journal.close();journal=null;
      const lines=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
      const original=structuredClone(lines);
      assert.equal(lines.at(-1).kind,'tool');
      // Replacing the real 'tool' with a checksum-valid 'finished' record
      // used to erase the pending tool reconciliation fence during load.
      // Recomputing SHA-256 is not an authorization to skip Query states.
      lines.at(-1).kind='finished';
      const {hash:old,...payload}=lines.at(-1);
      lines.at(-1).hash=sha(payload);
      await writeFile(path,lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
      await assert.rejects(
        openSessionJournal({workspace:root,sessionId:id,resume:true}),
        /Cannot finish an unfinished tool batch/,
        'checksum-valid forged final cannot bypass '+(makePartial?'partial':'pending'),
      );
      await writeFile(path,original.map(x=>JSON.stringify(x)).join('\n')+'\n');
      journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
      assert.equal(journal.needsToolReconciliation,false);
      assert.deepEqual(journal.messages,committed);
      await journal.close();journal=null;
    }
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
