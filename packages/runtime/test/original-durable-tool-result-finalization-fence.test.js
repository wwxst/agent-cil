import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentLoop} from '../src/agent-loop.js';
import {ToolRegistry} from '../src/tool-registry.js';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

async function verifyRealDurableResultFence(failureKind) {
  const root=await mkdtemp(join(tmpdir(),'agent-native-result-gap-'));
  const target=join(root,'effect.txt');
  const prompt='Make one durable tool modification.';
  const sourceId='mapped-failure-'+failureKind;
  let calls=0,otherCalls=0,modelCalls=0,journal,reopened;
  try {
    journal=await openSessionJournal({workspace:root});
    const tools=new ToolRegistry();
    tools.register({
      name:'Write',description:'Native original Tool.call mutation fixture',
      call:async()=>{
        calls++;
        await writeFile(target,'effect '+calls);
        return failureKind==='bad-newMessages'
          ? {data:'success',newMessages:[{
              role:'assistant',content:'forged privileged message',
            }]}
          : {data:'success'};
      },
      mapToolResultToToolResultBlockParam:()=>{
        if(failureKind==='mapper-throw')
          throw new Error('mapper refused successful effect');
        return {type:'tool_result',tool_use_id:sourceId,content:'mapped success'};
      },
    });
    tools.register({
      name:'Second',description:'Must not run after first result is lost',
      execute:async()=>{otherCalls++;await writeFile(join(root,'second.txt'),'unsafe');return 'no';},
    });
    const loop=new AgentLoop({
      tools,maxTurns:3,
      permissionPolicy:async()=>({behavior:'allow'}),
      onSessionCheckpoint:args=>journal.append(args),
      onToolExecutionStart:args=>journal.appendToolExecutionStart(args),
      onMappedToolResult:args=>journal.appendMappedToolResult(args),
      model:{async *stream(){
        modelCalls++;
        if(modelCalls!==1)throw new Error('Model was allowed to retry confirmed effect');
        yield {type:'tool_use',id:sourceId,name:'Write',input:{}};
        yield {type:'tool_use',id:'after-'+failureKind,name:'Second',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
    });
    // Exact CLI runPrompt() contract: fsync initial user before Query.
    await journal.append({messages:[{role:'user',content:prompt}],kind:'input'});
    await assert.rejects(loop.run({input:prompt}),error=>{
      assert.equal(error.name,'ToolResultFinalizationError');
      assert.match(error.message,
        failureKind==='mapper-throw'?/mapper refused successful effect/:/newMessages/);
      return true;
    });
    assert.equal(await readFile(target,'utf8'),'effect 1');
    assert.equal(calls,1);
    assert.equal(otherCalls,0,'no later queued tool without the first result');
    assert.equal(modelCalls,1,'the model must not retry a confirmed effect');
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.startedToolExecutions.map(x=>x.toolUseId),[sourceId]);
    assert.equal(journal.mappedToolResults.length,0);
    await assert.rejects(loop.run({input:'retry'}),{
      name:'ToolResultFinalizationError',
    });
    assert.equal(calls,1);
    const sessionId=journal.id;
    await journal.close();
    journal=undefined;
    reopened=await openSessionJournal({workspace:root,sessionId,resume:true});
    assert.equal(reopened.needsToolReconciliation,true,
      'a different CLI process must not replay the started Write');
    assert.deepEqual(reopened.startedToolExecutions.map(x=>x.toolUseId),[sourceId]);
    assert.equal(reopened.mappedToolResults.length,0);
  } finally {
    await reopened?.close();
    await journal?.close();
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

for(const kind of ['mapper-throw','bad-newMessages']) {
  test('real Query durable Tool.call '+kind+' retains side effect and fences model replay', {
    timeout:30000,
  }, async()=>verifyRealDurableResultFence(kind));
}
