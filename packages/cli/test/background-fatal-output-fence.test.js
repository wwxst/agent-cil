import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinTools,cleanupLiveShellCommands,getShellLifecycleStatus}
  from '../src/index.js';
import {TaskOutput} from '../src/legacy-task-output.js';
import {createLocalShellTaskManager} from '../src/local-shell-task.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=9000){
  const began=Date.now();
  while(Date.now()-began<timeout){
    if(await predicate())return;
    await pause(25);
  }
  throw new Error('Timed out before actual native Bash finished.');
}
async function inWorkspace(run){
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bg-fatal-output-'));
  const manager=createLocalShellTaskManager({sessionId:randomUUID()});
  try{
    const tools=await createBuiltinTools({workspace:root,taskManager:manager});
    await run({root,manager,tools});
  }finally{
    await manager.killShellTasksForAgent().catch(()=>{});
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
const commandFor=(script)=>'"'+process.execPath.replaceAll('"','')+
  '" "'+script.replaceAll('"','')+'"';
function forceOutputFailure(taskId){
  const original=TaskOutput.prototype.getStdout;
  TaskOutput.prototype.getStdout=async function(...args){
    if(this.taskId===taskId){
      const error=new Error('injected native Bash output read/identity failure');
      error.name='TaskOutputPersistenceError';
      throw error;
    }
    return original.apply(this,args);
  };
  return ()=>{TaskOutput.prototype.getStdout=original;};
}

test('actual TaskStop may not report success when killed Bash cannot finalize its native output',{
  timeout:25000,
},async()=>{
  await inWorkspace(async({root,manager,tools})=>{
    const script=join(root,'long-running.cjs');
    await writeFile(script,
      "const fs=require('node:fs');"+
      "setInterval(()=>{fs.appendFileSync('heartbeat.txt','1');"+
      "process.stdout.write('IN_PROGRESS\\n');},35);");
    const started=await tools.get('Bash').execute({
      command:commandFor(script),run_in_background:true,timeout_ms:15000,
    });
    const taskId=started.backgroundTaskId;
    assert.ok(taskId);
    const heartbeat=join(root,'heartbeat.txt');
    await waitFor(async()=>{
      try{return (await readFile(heartbeat,'utf8')).length>=3;}
      catch(error){if(error.code==='ENOENT')return false;throw error;}
    });
    const restore=forceOutputFailure(taskId);
    try{
      await assert.rejects(tools.get('TaskStop').execute({task_id:taskId}),
        error=>error?.name==='TaskOutputPersistenceError' &&
          /native Bash output read\/identity failure/.test(error.message));
      assert.equal(manager.status(taskId)?.status,'failed',
        'a failed native output finalization cannot become TaskStop killed/success');
      assert.throws(()=>manager.pendingNotifications(),error=>
        error?.name==='TaskOutputPersistenceError');
      await assert.rejects(tools.get('TaskOutput').execute({
        task_id:taskId,block:false,
      }),error=>error?.name==='TaskOutputPersistenceError');
      await assert.rejects(manager.killShellTasksForAgent(),error=>
        error instanceof AggregateError && error.errors.some(x=>
          x?.name==='TaskOutputPersistenceError'));
      const snapshot=await readFile(heartbeat,'utf8');
      await pause(350);
      assert.equal(await readFile(heartbeat,'utf8'),snapshot,
        'native process tree must really stop despite fatal output result');
      assert.deepEqual(getShellLifecycleStatus(),{
        liveShellCommands:0,pendingKillBackstops:0,
      });
    }finally{restore();}
  });
});

test('natural background Bash output corruption blocks next Query notification and session shutdown',{
  timeout:25000,
},async()=>{
  await inWorkspace(async({root,manager,tools})=>{
    const script=join(root,'quick-exit.cjs');
    await writeFile(script,
      "process.stdout.write('COMPLETED_IN_OS\\n');"+
      "setTimeout(()=>process.exit(0),600);");
    let chosenId;
    const original=TaskOutput.prototype.getStdout;
    TaskOutput.prototype.getStdout=async function(...args){
      if(this.taskId===chosenId){
        const error=new Error('native TaskOutput file replaced after exit');
        error.name='TaskOutputPersistenceError';
        throw error;
      }
      return original.apply(this,args);
    };
    try{
      const started=await tools.get('Bash').execute({
        command:commandFor(script),run_in_background:true,timeout_ms:8000,
      });
      chosenId=started.backgroundTaskId;
      assert.ok(chosenId);
      await waitFor(()=>manager.status(chosenId)?.status==='failed');
      assert.match(manager.status(chosenId)?.description,/quick-exit/);
      assert.throws(()=>manager.pendingNotifications(),error=>
        error?.name==='TaskOutputPersistenceError');
      await assert.rejects(tools.get('TaskOutput').execute({
        task_id:chosenId,block:true,timeout:1000,
      }),error=>error?.name==='TaskOutputPersistenceError');
      await assert.rejects(manager.killShellTasksForAgent(),error=>
        error instanceof AggregateError && error.errors.some(x=>
          x?.name==='TaskOutputPersistenceError'));
      assert.deepEqual(getShellLifecycleStatus(),{
        liveShellCommands:0,pendingKillBackstops:0,
      });
    }finally{TaskOutput.prototype.getStdout=original;}
  });
});
