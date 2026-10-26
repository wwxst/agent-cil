import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { openSessionJournal } from '../src/legacy-session/session-storage.js';

/**
 * Source 2.1.88 interrupt propagation must NOT hide an unsuccessful
 * 2.1.304-style native subtree kill. This exercises original AgentLoop,
 * StreamingToolExecutor, Query and the real durable SessionJournal,
 * independent of Windows-only taskkill OS failure injection.
 */
test('OS cleanup uncertainty beats concurrent AbortSignal and blocks sibling side effects', {
  timeout: 20000,
}, async() => {
  const workspace=await mkdtemp(join(tmpdir(),'agent-cil-fatal-tree-'));
  let journal;
  try {
    const controller=new AbortController();
    journal=await openSessionJournal({workspace,sessionId:randomUUID()});
    const input=[{role:'user',content:'Perform two operations'}];
    await journal.append({messages:input,kind:'input'});
    const tools=new ToolRegistry();
    const toolCalls=[];
    tools.register({
      name:'Write',description:'Writes one file after permission',
      call:async ({index})=>{
        toolCalls.push(index);
        if(index===1){
          // This is the tool boundary after real permission and durable
          // tool_started, simulating a failed Windows taskkill after a
          // background side effect. The AbortSignal races with the error.
          controller.abort(new Error('User requested cancellation'));
          const error=new Error(
            'Windows Bash process-tree cleanup could not be confirmed: taskkill exit 1. Unowned descendants may remain.');
          error.name='ProcessTreeCleanupError';
          throw error;
        }
        return {data:'unexpected second side effect'};
      },
      mapToolResultToToolResultBlockParam:(data,id)=>({
        type:'tool_result',tool_use_id:id,content:data,
      }),
    });
    const loop=new AgentLoop({
      tools,permissionPolicy:async()=>({behavior:'allow'}),maxTurns:3,
      onSessionCheckpoint:checkpoint=>journal.append(checkpoint),
      onToolExecutionStart:record=>journal.appendToolExecutionStart(record),
      model:{async *stream(){
        requests++;
        yield {type:'tool_use',id:'unsafe-first',name:'Write',input:{index:1}};
        yield {type:'tool_use',id:'later-second',name:'Write',input:{index:2}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
    });
    let requests=0;
    await assert.rejects(loop.run({input:input[0].content,signal:controller.signal}),
      error=>error?.name==='ProcessTreeCleanupError' &&
        /Unowned descendants may remain/.test(error.message),
      'uncertain OS process cleanup must not be downgraded to AbortError');
    assert.equal(requests,1,'must not request another model round');
    assert.deepEqual(toolCalls,[1],'second queued tool must never run');
    assert.equal(journal.needsToolReconciliation,true);
    assert.deepEqual(journal.startedToolExecutions.map(x=>x.toolUseId),
      ['unsafe-first']);
    assert.deepEqual(journal.mappedToolResults,[]);
    assert.deepEqual(journal.messages.map(x=>x.role),['user','assistant']);
    await journal.close();
    journal=undefined;
    const records=(await readFile(join(workspace,'.agent-cil','sessions',
      [...(await (await import('node:fs/promises')).readdir(join(workspace,'.agent-cil','sessions')))].at(0),
      'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),
      ['input','tool_pending','tool_started'],
      'no invented tool_result after abort and unconfirmed OS cleanup');
  }finally {
    if(journal)await journal.close();
    await rm(workspace,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
