import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinTools,createCliPermissionPolicy,
  cleanupLiveShellCommands,getShellLifecycleStatus} from '../src/index.js';
import {createLocalShellTaskManager} from '../src/local-shell-task.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function readOptional(path){
  try{return await readFile(path,'utf8');}
  catch(error){if(error.code==='ENOENT')return '';throw error;}
}
test('source run_in_background TaskOutput and TaskStop own a real Bash process tree on Windows/Linux',{
 timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-local-shell-task-'));
  const sessionId=randomUUID();
  const manager=createLocalShellTaskManager({sessionId});
  let taskId;
  try {
    const script=join(root,'background.cjs');
    await writeFile(script,[
      "const fs=require('node:fs');",
      "process.stdout.write('BACKGROUND_SHELL_STARTED\\n');",
      "setInterval(()=>{",
      "fs.appendFileSync('task-heartbeat.txt','tick\\n');",
      "process.stdout.write('BACKGROUND_TICK\\n');",
      "},40);",
    ].join('\n'));
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    const tools=await createBuiltinTools({
      workspace:root,taskManager:manager,taskSession:{workspace:root,sessionId},
    });
    const result=await tools.get('Bash').execute({
      command,run_in_background:true,timeout_ms:12000,
    });
    assert.equal(result.exit_code,0);
    assert.equal(result.error,undefined);
    taskId=result.backgroundTaskId;
    assert.match(taskId,/^[0-9a-f-]{36}$/i);
    assert.equal(taskId,result.outputTaskId);
    assert.ok(result.outputFilePath.endsWith(taskId+'.output'));
    assert.equal(manager.status(taskId)?.status,'running');
    const policy=createCliPermissionPolicy({
      workspace:root,sessionId,taskManager:manager,
    });
    assert.equal((await policy({name:'TaskOutput',input:{task_id:taskId}})).behavior,'allow');
    assert.equal((await policy({name:'TaskStop',input:{task_id:taskId}})).behavior,'allow');
    assert.equal((await policy({name:'TaskOutput',input:{task_id:randomUUID()}})).behavior,'deny');
    let hadSideEffect=false;
    for(let i=0;i<120;i++){
      if((await readOptional(join(root,'task-heartbeat.txt'))).length>0){
        hadSideEffect=true;break;
      }
      await pause(35);
    }
    assert.ok(hadSideEffect,'background task actually ran while the tool turn returned');
    const snapshot=await tools.get('TaskOutput').execute({
      task_id:taskId,block:false,
    });
    assert.equal(snapshot.retrieval_status,'not_ready');
    assert.equal(snapshot.task.status,'running');
    assert.match(snapshot.task.output,/BACKGROUND_SHELL_STARTED/);
    assert.equal((await policy({
      name:'Read',input:{file_path:result.outputFilePath,offset:0,limit:2},
    })).behavior,'allow','source background output path is readable while still running');
    const liveLog=await tools.get('Read').execute({
      file_path:result.outputFilePath,offset:0,limit:2,
    });
    assert.match(liveLog,/BACKGROUND_SHELL_STARTED/);
    const stopped=await tools.get('TaskStop').execute({task_id:taskId});
    assert.equal(stopped.task_id,taskId);
    const final=await tools.get('TaskOutput').execute({task_id:taskId,block:true,timeout:1000});
    assert.equal(final.retrieval_status,'success');
    assert.equal(final.task.status,'killed');
    const after=await readOptional(join(root,'task-heartbeat.txt'));
    await pause(430);
    assert.equal(await readOptional(join(root,'task-heartbeat.txt')),after,
      'TaskStop must stop descendant side effects, not only the foreground CLI tool call');
    assert.equal((await policy({name:'TaskStop',input:{task_id:taskId}})).behavior,'deny');
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
    await assert.rejects(tools.get('TaskStop').execute({task_id:taskId}),
      /not running/);
  } finally {
    await manager.killShellTasksForAgent().catch(()=>{});
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:130});
  }
});

test('background Bash completes normally and TaskOutput block returns completed output', {
 timeout:25000,
},async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-cil-bg-completion-'));
 const manager=createLocalShellTaskManager({sessionId:randomUUID()});
 try{
   const script=join(root,'complete.cjs');
   await writeFile(script,"process.stdout.write('SOURCE_TASK_FINISHED\\n');setTimeout(()=>process.exit(0),600);");
   const tools=await createBuiltinTools({workspace:root,taskManager:manager});
   const result=await tools.get('Bash').execute({
     command:'"'+process.execPath.replaceAll('"','')+'" "'+script.replaceAll('"','')+'"',
     run_in_background:true,timeout_ms:10000,
   });
   const task=await tools.get('TaskOutput').execute({
     task_id:result.backgroundTaskId,block:true,timeout:8000,
   });
   assert.equal(task.retrieval_status,'success');
   assert.equal(task.task.status,'completed');
   assert.equal(task.task.exitCode,0);
   assert.match(task.task.output,/SOURCE_TASK_FINISHED/);
   assert.equal(manager.status(result.backgroundTaskId)?.notified,true);
   assert.deepEqual(getShellLifecycleStatus(),{
     liveShellCommands:0,pendingKillBackstops:0,
   });
 }finally{
   await manager.killShellTasksForAgent().catch(()=>{});
   await cleanupLiveShellCommands().catch(()=>{});
   await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:130});
 }
});
