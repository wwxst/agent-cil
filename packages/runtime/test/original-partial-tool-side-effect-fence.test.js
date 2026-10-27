import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentLoop} from '../src/agent-loop.js';
import {ToolRegistry} from '../src/tool-registry.js';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';
import {createLocalShellTaskManager} from '../../cli/src/local-shell-task.js';

async function actualSessionCase(task) {
  const root=await mkdtemp(join(tmpdir(),'agent-partial-native-tool-'));
  let journal,restored;
  try {
    journal=await openSessionJournal({workspace:root});
    await task({root,journal});
  } finally {
    await restored?.close();
    await journal?.close();
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

for(const implementation of ['execute','call']) {
  test('real SessionJournal: original '+implementation+
    ' throws AFTER entering filesystem mutation; no provider retry, failure Hook retained', {
    timeout:30000,
  },async()=>{
    await actualSessionCase(async({root,journal})=>{
      const id='partial-write-'+implementation;
      const effect=join(root,'effect.txt');
      await writeFile(join(root,'failure.cjs'),
        "let input='';process.stdin.on('data',x=>input+=x);"+
        "process.stdin.on('end',()=>{require('node:fs').writeFileSync("+
        "'failure-hook.json',input);});");
      let calls=0,modelCalls=0,queuedCalls=0;
      const tools=new ToolRegistry();
      const perform=async(_input,{markSideEffectsStarted})=>{
        // Even when the original native call throws, its successful
        // filesystem operation has already happened.
        markSideEffectsStarted();
        calls++;
        await writeFile(effect,'completed edit '+calls);
        throw new Error('disk sync failed after edit mutation');
      };
      tools.register({
        name:'Write',description:'Original native partial-write fixture',
        ...(implementation==='call'
          ? {call:perform,mapToolResultToToolResultBlockParam:(_data,toolUseId)=>
              ({type:'tool_result',tool_use_id:toolUseId,content:'never'})}
          : {execute:perform}),
      });
      tools.register({name:'Next',description:'Must stay queued',
        execute:async()=>{queuedCalls++;return 'unsafe';}});
      const finished=[];
      const loop=new AgentLoop({
        tools,maxTurns:3,hookWorkspace:root,
        hookSessionId:journal.id,hookTranscriptPath:journal.path,
        permissionPolicy:async()=>({behavior:'allow'}),
        onSessionCheckpoint:value=>journal.append(value),
        onToolExecutionStart:value=>journal.appendToolExecutionStart(value),
        onMappedToolResult:value=>journal.appendMappedToolResult(value),
        postToolUseFailureHooks:[{
          matcher:'Write',type:'command',command:'node failure.cjs',timeout:8,
        }],
        model:{async *stream(){
          modelCalls++;
          if(modelCalls!==1)throw new Error('Tool was retried after partial edit');
          yield {type:'tool_use',id,name:'Write',input:{}};
          yield {type:'tool_use',id:'queued',name:'Next',input:{}};
          yield {type:'message_end',stopReason:'tool_use'};
        }},
      });
      loop.on('toolCallFinished',event=>finished.push(event));
      const prompt='Apply a single change.';
      await journal.append({messages:[{role:'user',content:prompt}],kind:'input'});
      await assert.rejects(loop.run({input:prompt}),error=>{
        assert.equal(error.name,'ToolResultFinalizationError');
        assert.match(error.message,/entered a side-effecting operation/);
        assert.match(error.message,/disk sync failed after edit mutation/);
        return true;
      });
      assert.equal(await readFile(effect,'utf8'),'completed edit 1');
      assert.equal(calls,1);
      assert.equal(modelCalls,1);
      assert.equal(queuedCalls,0);
      assert.deepEqual(finished.filter(x=>x.toolUseId===id).map(x=>x.isError),[true]);
      assert.equal(journal.needsToolReconciliation,true);
      assert.deepEqual(journal.startedToolExecutions.map(x=>x.toolUseId),[id]);
      assert.equal(journal.mappedToolResults.length,0);
      const observed=JSON.parse(await readFile(join(root,'failure-hook.json'),'utf8'));
      assert.equal(observed.hook_event_name,'PostToolUseFailure');
      assert.equal(observed.tool_use_id,id);
      assert.equal(observed.is_interrupt,false);
      assert.match(observed.error,/disk sync failed after edit mutation/);
      await assert.rejects(loop.run({input:'try again'}),{
        name:'ToolResultFinalizationError',
      });
      const sessionId=journal.id;
      await journal.close();
      const resumed=await openSessionJournal({workspace:root,sessionId,resume:true});
      try {
        assert.equal(resumed.needsToolReconciliation,true);
        assert.deepEqual(resumed.startedToolExecutions.map(x=>x.toolUseId),[id]);
        assert.equal(resumed.mappedToolResults.length,0);
      }finally{await resumed.close();}
    });
  });
}

test('real Query: native Edit validation error before mutation remains recoverable and resumable', {
  timeout:20000,
},async()=>{
  await actualSessionCase(async({root,journal})=>{
    const tools=new ToolRegistry();
    let calls=0,requests=0;
    tools.register({name:'Edit',description:'No writable side effect',
      execute:async()=>{
        calls++;
        // A missing old_string fails before markSideEffectsStarted(), exactly
        // as the built-in Edit tool does before writeTextHandle().
        throw new Error('old_string was not found in file');
      },
    });
    const loop=new AgentLoop({
      tools,permissionPolicy:async()=>({behavior:'allow'}),maxTurns:2,
      onSessionCheckpoint:value=>journal.append(value),
      onToolExecutionStart:value=>journal.appendToolExecutionStart(value),
      model:{async *stream({messages}){
        requests++;
        if(requests===1){
          yield {type:'tool_use',id:'missing-edit',name:'Edit',input:{}};
          yield {type:'message_end',stopReason:'tool_use'};
        }else{
          assert.equal(messages.at(-1).content[0].is_error,true);
          assert.match(messages.at(-1).content[0].content,/old_string was not found/);
          yield {type:'text_delta',text:'I need an exact match.'};
          yield {type:'message_end',stopReason:'end_turn'};
        }
      }},
    });
    const prompt='edit a nonexistent match';
    await journal.append({messages:[{role:'user',content:prompt}],kind:'input'});
    const result=await loop.run({input:prompt});
    assert.equal(result.stopReason,'end_turn');
    assert.equal(calls,1);
    assert.equal(requests,2);
    assert.equal(journal.needsToolReconciliation,false);
    assert.equal(journal.startedToolExecutions.length,0);
    const sessionId=journal.id;
    await journal.close();
    const restored=await openSessionJournal({workspace:root,sessionId,resume:true});
    try{
      assert.equal(restored.needsToolReconciliation,false);
      assert.equal(restored.messages.at(-1).content[0].text,'I need an exact match.');
    }finally{await restored.close();}
  });
});

test('real Query: abort after a native mutation does not make session safe to replay', {
  timeout:20000,
},async()=>{
  await actualSessionCase(async({root,journal})=>{
    const tools=new ToolRegistry();
    const controller=new AbortController();
    let calls=0,requests=0;
    tools.register({name:'Write',description:'Cancelled after disk write',
      execute:async(_input,{markSideEffectsStarted})=>{
        markSideEffectsStarted();
        calls++;
        await writeFile(join(root,'effect.txt'),'written once');
        controller.abort(new Error('User interrupted after mutation'));
        throw new Error('Native write interrupted while finalizing');
      },
    });
    const loop=new AgentLoop({
      tools,permissionPolicy:async()=>({behavior:'allow'}),maxTurns:3,
      onSessionCheckpoint:value=>journal.append(value),
      onToolExecutionStart:value=>journal.appendToolExecutionStart(value),
      model:{async *stream(){
        requests++;
        yield {type:'tool_use',id:'abort-after-write',name:'Write',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
    });
    const prompt='apply one mutation';
    await journal.append({messages:[{role:'user',content:prompt}],kind:'input'});
    await assert.rejects(loop.run({input:prompt,signal:controller.signal}),error=>{
      assert.equal(error.name,'ToolResultFinalizationError');
      assert.match(error.message,/Native write interrupted/);
      return true;
    });
    assert.equal(calls,1);
    assert.equal(requests,1);
    assert.equal(await readFile(join(root,'effect.txt'),'utf8'),'written once');
    assert.equal(journal.needsToolReconciliation,true);
    await assert.rejects(loop.run({input:'repeat'}),{
      name:'ToolResultFinalizationError',
    });
  });
});

test('native TaskStop only marks effects at live process-tree kill, not unknown or completed IDs',async()=>{
  const manager=createLocalShellTaskManager({sessionId:'source-task-stop-fence'});
  let marks=0,kills=0,completeTask;
  await assert.rejects(manager.stopTask('nonexistent',{
    markSideEffectsStarted:()=>{marks++;},
  }),/No task found/);
  assert.equal(marks,0);
  const completion=new Promise(resolve=>{completeTask=resolve;});
  manager.spawnShellTask({
    taskOutput:{taskId:'running-task',path:'owned-output'},
    command:'sleep 10',
    completion,
    kill:async()=>{
      kills++;
      completeTask({exit_code:1,stdout:'',stderr:''});
    },
  });
  await manager.stopTask('running-task',{
    markSideEffectsStarted:()=>{marks++;},
  });
  assert.equal(marks,1,'mark exactly once before native task.kill()');
  assert.equal(kills,1);
  await assert.rejects(manager.stopTask('running-task',{
    markSideEffectsStarted:()=>{marks++;},
  }),/not running/);
  assert.equal(marks,1,'completed task must remain a recoverable tool error');
});
