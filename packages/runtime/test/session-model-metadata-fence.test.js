import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

const initial=[{role:'user',content:'Original first task.'}];
const finished=[...initial,{role:'assistant',
  content:[{type:'text',text:'Original completion retained.'}]}];
test('metadata kind cannot commit model-visible history; real model override remains an independent hash-linked journal witness',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-model-metadata-fence-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:initial,kind:'input'});
    await assert.rejects(journal.append({
      messages:finished,kind:'model_override',
    }),/Metadata and tool witnesses must use dedicated append methods/);
    assert.deepEqual(journal.messages,initial);
    await journal.appendModelOverride({provider:'anthropic',setting:'opus'});
    assert.deepEqual(journal.modelOverride,{provider:'anthropic',setting:'opus'});
    assert.deepEqual(journal.messages,initial,
      'model selection must never change provider-visible messages');
    await journal.close();journal=null;
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.modelOverride,{provider:'anthropic',setting:'opus'});
    assert.deepEqual(journal.messages,initial);
    assert.equal(journal.canContinueWithoutPrompt,true);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});

test('checksum-valid session_commit/model_override forgery cannot hide real assistant history during replay',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-forged-model-commit-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:initial,kind:'input'});
    await journal.append({messages:finished,kind:'finished'});
    const path=journal.path;
    await journal.close();journal=null;
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    const forged=structuredClone(records);
    forged[1].kind='model_override';
    const {hash:_old,...payload}=forged[1];
    forged[1].hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(path,forged.map(x=>JSON.stringify(x)).join('\n')+'\n');
    await assert.rejects(openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Metadata and execution witnesses must not masquerade as transcript entries/,
      'a valid SHA alone cannot authorize metadata as a source conversation commit');
    await writeFile(path,records.map(x=>JSON.stringify(x)).join('\n')+'\n');
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.messages,finished);
    assert.equal(journal.canContinueWithoutPrompt,false);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});


test('source legacy v1 migration never accepts model_override as a transcript snapshot kind',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-legacy-model-kind-'));
  const id=randomUUID();
  let journal;
  try {
    journal=await openSessionJournal({workspace:root,sessionId:id});
    const path=journal.path;
    await journal.close();journal=null;
    const payload={
      type:'session_checkpoint',version:1,sessionId:id,
      workspace:await (await import('node:fs/promises')).realpath(root),
      kind:'model_override',sequence:1,
      previousHash:'0'.repeat(64),messages:finished,
    };
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(path,JSON.stringify({...payload,hash})+'\n');
    await assert.rejects(
      openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Legacy checkpoint kind was never supported/,
    );
    // Genuine pre-upgrade v1 snapshot still uses the supported 'tool'
    // kind and must remain migratable without transcript changes.
    payload.kind='tool';
    const goodHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(path,JSON.stringify({...payload,hash:goodHash})+'\n');
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.messages,finished);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
