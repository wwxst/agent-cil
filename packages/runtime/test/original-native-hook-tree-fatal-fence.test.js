import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentLoop} from '../src/agent-loop.js';
import {ToolRegistry} from '../src/tool-registry.js';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

async function waitForHookPid(file, getRunStatus) {
  for(let attempt=0;attempt<150;attempt++) {
    try {
      const pid=Number(await readFile(file,'utf8'));
      if(Number.isSafeInteger(pid)&&pid>0)return pid;
    }catch(error){if(error?.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('Real Hook subprocess never started: '+JSON.stringify(getRunStatus()));
}

async function exerciseUncertainHookCleanup(event) {
  const root=await mkdtemp(join(tmpdir(),'agent-hook-fatal-fence-'));
  const pidFile=join(root,'hook-pid.txt');
  const originalKill=process.kill;
  const originalSystemRoot=process.env.SystemRoot;
  let hookPid,journal,running,abort,modelCalls=0,toolCalls=0;
  let toolStarts=0;
  try {
    // This script actually starts a Node process beneath the Hook shell.
    // Its PID is retained so our test can clean it up after deliberately
    // simulating an OS failure to terminate the entire process tree.
    await writeFile(join(root,'slow.cjs'),
      "require('node:fs').writeFileSync('hook-pid.txt',String(process.pid));"+
      "setInterval(()=>{},1000);");
    journal=await openSessionJournal({workspace:root});
    abort=new AbortController();
    const tools=new ToolRegistry();
    tools.register({
      name:'Write',description:'Side-effecting original native tool',
      inputSchema:{type:'object',properties:{content:{type:'string'}},
        required:['content'],additionalProperties:false},
      execute:async input=>{
        toolCalls++;
        if(event==='PostToolUseFailure')throw new Error('actual tool execution failure');
        return {done:input.content};
      },
    });
    const hook={type:'command',command:'node slow.cjs',matcher:'Write',timeout:8};
    const loop=new AgentLoop({
      model:{async *stream(){
        modelCalls++;
        if(modelCalls!==1)throw new Error('Unsafe model retry after cleanup failure');
        yield {type:'tool_use',id:'hook-uncertain',name:'Write',
          input:{content:'must never be replayed'}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
      tools,
      permissionPolicy:async()=>({behavior:'allow'}),
      preToolUseHooks:event==='PreToolUse'?[hook]:[],
      postToolUseHooks:event==='PostToolUse'?[hook]:[],
      postToolUseFailureHooks:event==='PostToolUseFailure'?[hook]:[],
      hookWorkspace:root,
      hookSessionId:journal.id,
      hookTranscriptPath:journal.path,
      onSessionCheckpoint:checkpoint=>journal.append(checkpoint),
      onToolExecutionStart:args=>{toolStarts++;return journal.appendToolExecutionStart(args);},
      onMappedToolResult:args=>journal.appendMappedToolResult(args),
      maxTurns:3,
    });
    running=loop.run({input:'Execute the selected original tool',signal:abort.signal});
    let runStatus={stage:'still running'};
    void running.then(result=>{
      runStatus={stage:'resolved',result:result?.stopReason,
        lastResult:result?.messages?.at(-1)};
    },error=>{
      runStatus={stage:'rejected',name:error?.name,message:error?.message,
        stack:error?.stack};
    });
    hookPid=await waitForHookPid(pidFile,()=>({
      event,modelCalls,toolCalls,toolStarts,
      journalStatus:journal.needsToolReconciliation,
      started:journal.startedToolExecutions,
      mapped:journal.mappedToolResults,
      run:runStatus,
    }));
    // The child is really alive. Refuse just the OS tree-kill primitive
    // while preserving its direct-child fallback. A silent fallback was the
    // bug: original Hook generator would turn this into an ordinary message.
    if(process.platform==='win32') {
      process.env.SystemRoot=join(root,'nonexistent-Windows-SystemRoot');
    }else{
      process.kill=(pid,signal)=>{
        if(pid<0) {
          const error=new Error('Injected EPERM on Hook process-group kill');
          error.code='EPERM';
          throw error;
        }
        return originalKill(pid,signal);
      };
    }
    abort.abort(new Error('User requested interruption'));
    await assert.rejects(running,error=>{
      assert.equal(error.name,'ProcessTreeCleanupError');
      assert.match(error.message,/Native Hook process-tree cleanup could not be confirmed/);
      return true;
    });
    assert.equal(modelCalls,1,'no model continuation after an uncertain Hook tree');
    assert.equal(toolCalls,event==='PreToolUse'?0:1,
      'PreToolUse must not execute; PostToolUse retains completed real tool effect');
    assert.equal(toolStarts,event==='PreToolUse'?0:1,
      'durable original tool-start witness must match actual execution');
    assert.equal(journal.needsToolReconciliation,true);
    assert.equal(journal.startedToolExecutions.length,
      event==='PreToolUse'?0:1);
    assert.equal(journal.mappedToolResults.length,
      event==='PostToolUse'?1:0);
    assert.equal(loop.active,false);
    await assert.rejects(loop.run({input:'another request'}),{
      name:'ProcessTreeCleanupError',
    });
    assert.equal(modelCalls,1);
  }finally{
    process.kill=originalKill;
    if(originalSystemRoot===undefined)delete process.env.SystemRoot;
    else process.env.SystemRoot=originalSystemRoot;
    abort?.abort();
    await running?.catch(()=>{});
    if(hookPid) {
      try {originalKill(hookPid,'SIGKILL');}catch{}
    }
    await journal?.close();
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

for(const event of ['PreToolUse','PostToolUse','PostToolUseFailure']){
  test('actual AgentLoop '+event+' process-tree kill failure fences tool, Query, and session', {
    timeout:30000,
  }, async()=>exerciseUncertainHookCleanup(event));
}
