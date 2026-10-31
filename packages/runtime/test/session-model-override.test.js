import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

const messages=[
  {role:'user',content:'Retain this old conversation.'},
  {role:'assistant',content:[{type:'text',text:'Previously completed.'}]},
];

test('session-only /model metadata retains original UUID transcript, response and recovery kind across resume',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cli-model-journal-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:messages.slice(0,1),kind:'input'});
    await journal.append({messages,kind:'finished'});
    assert.equal(journal.modelOverride,undefined);
    await journal.appendModelOverride({provider:'anthropic',setting:'opus'});
    assert.deepEqual(journal.modelOverride,{provider:'anthropic',setting:'opus'});
    assert.deepEqual(journal.messages,messages);
    await journal.close();journal=null;

    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.modelOverride,{provider:'anthropic',setting:'opus'});
    assert.deepEqual(journal.messages,messages);
    assert.equal(journal.needsToolReconciliation,false);
    assert.equal(journal.canContinueWithoutPrompt,false,
      'a model-only metadata record must not turn a completed conversation into a pending turn');

    const newMessages=[...messages,{role:'user',content:'Continue after model switch'}];
    await journal.append({messages:newMessages,kind:'input'});
    await journal.appendModelOverride({provider:'anthropic',setting:null});
    await journal.close();journal=null;

    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.modelOverride,{provider:'anthropic',setting:null});
    assert.deepEqual(journal.messages,newMessages);
    assert.equal(journal.canContinueWithoutPrompt,true,
      'model metadata after an unanswered prompt must retain the original pending-input boundary');
    const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),[
      'input','finished','model_override','input','model_override',
    ]);
    assert.equal(records[2].leafUuid,records[1].leafUuid);
    assert.equal(records[4].leafUuid,records[3].leafUuid);
    assert.equal(records[2].entries,undefined);
    assert.equal(records[4].entries,undefined);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});

test('model metadata refuses unsafe or forged values before mutating durable history',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cli-model-tamper-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    await journal.append({messages:messages.slice(0,1),kind:'input'});
    for(const record of [
      {provider:'unknown',setting:'opus'},
      {provider:'anthropic',setting:''},
      {provider:'anthropic',setting:' bad '},
      {provider:'anthropic',setting:'x'.repeat(1025)},
      {provider:'anthropic',setting:12},
    ]) await assert.rejects(journal.appendModelOverride(record),/Invalid session model/);
    assert.equal(journal.modelOverride,undefined);
    await journal.appendModelOverride({provider:'anthropic',setting:'sonnet'});
    const path=journal.path;
    await journal.close();journal=null;

    const original=await readFile(path,'utf8');
    const lines=original.trimEnd().split('\n');
    const last=JSON.parse(lines.at(-1));
    // Even a recomputed SHA-256 cannot make a forged model record pass
    // model ancestry validation (which binds the record to a real leaf).
    last.leafUuid=randomUUID();
    const {hash,...payload}=last;
    last.hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    lines[lines.length-1]=JSON.stringify(last);
    await writeFile(path,lines.join('\n')+'\n');
    await assert.rejects(
      openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Invalid session model override record/,
    );
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});


test('model metadata cannot rewrite unfinished Bash tool batch or disguise interruption on resume',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cli-model-tool-fence-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Run the tool once'}];
    const pending=[...input,{role:'assistant',content:[{
      type:'tool_use',id:'pending-Bash',name:'Bash',
      input:{command:'node write-once.cjs'},
    }]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await assert.rejects(journal.appendModelOverride({
      provider:'anthropic',setting:'opus',
    }),/unfinished tool reconciliation/);
    assert.deepEqual(journal.messages,pending);
    await journal.close();journal=null;
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.equal(journal.modelOverride,undefined);
    assert.equal(journal.needsToolReconciliation,true);
    assert.equal(journal.canContinueWithoutPrompt,false);
    const records=(await readFile(journal.path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input','tool_pending']);
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
