import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinTools,cleanupLiveShellCommands,
  getShellLifecycleStatus} from '../src/index.js';
import {createLocalShellTaskManager} from '../src/local-shell-task.js';
import {TaskOutput,isReadableInternalTaskOutputPath} from '../src/legacy-task-output.js';

// 2.1.88 LocalShellTask/killShellTasks.ts and the 2.1.304 process-tree
// cleanup fence must complete BEFORE a failed background admission
// produces a tool result. Returning a Promise rejection at spawn time while
// the shell remains registered allows the model to start another Bash/Write.
async function exerciseFailure({afterRegistration=false}) {
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bg-admission-'));
  const sessionId=randomUUID();
  const realManager=createLocalShellTaskManager({sessionId});
  const originalRegister=TaskOutput.prototype.registerRunningOutput;
  let registeredId=null;
  let failedOutputPath=null;
  let manager=realManager;
  if(afterRegistration) {
    const original=realManager.spawnShellTask.bind(realManager);
    realManager.spawnShellTask=(input)=>{
      failedOutputPath=input.taskOutput.path;
      registeredId=original(input);
      return registeredId;
    };
    TaskOutput.prototype.registerRunningOutput=function () {
      throw new Error('simulated output-registration failure');
    };
  }else {
    manager={
      spawnShellTask({taskOutput}) {
        failedOutputPath=taskOutput.path;
        throw new Error('simulated background task ownership rejection');
      },
    };
  }
  try {
    const script=join(root,'worker.cjs');
    await writeFile(script,"setInterval(()=>process.stdout.write('working\\n'),25);");
    const tools=await createBuiltinTools({
      workspace:root,taskManager:manager,taskSession:{workspace:root,sessionId},
    });
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    await assert.rejects(
      tools.get('Bash').execute({
        command,run_in_background:true,timeout_ms:10000,
      }),
      afterRegistration?/simulated output-registration failure/:
        /simulated background task ownership rejection/,
    );
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    },'the rejected background tool must not release its result before OS cleanup');
    assert.ok(failedOutputPath);
    assert.equal(isReadableInternalTaskOutputPath(root,failedOutputPath,sessionId),false,
      'a Bash admission error must not authorize an orphaned output path');
    if(afterRegistration) {
      assert.ok(registeredId,'the task had reached source LocalShellTask registration');
      assert.equal(realManager.status(registeredId)?.notified,true,
        'an unreported background tool cannot queue a ghost completion');
      assert.deepEqual(realManager.pendingNotifications(),[]);
    }
  } finally {
    TaskOutput.prototype.registerRunningOutput=originalRegister;
    await realManager.killShellTasksForAgent().catch(()=>{});
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

test('background Bash ownership rejection awaits actual process cleanup before tool error',
  {timeout:25000},async()=>exerciseFailure({afterRegistration:false}));

test('failure after background registration suppresses ghost notice and awaits cleanup',
  {timeout:25000},async()=>exerciseFailure({afterRegistration:true}));
