import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createBuiltinTools,cleanupLiveShellCommands,getShellLifecycleStatus,
} from '../src/index.js';
import {TaskOutput} from '../src/legacy-task-output.js';

async function untilExists(path){
  for(let i=0;i<150;i++){
    try{await stat(path);return;}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('Live child did not start before cleanup');
}

test('native Bash owner cleanup waits for async close/output finalization before releasing session resources',{
  timeout:25000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-shell-owner-final-'));
  const originalGetStdout=TaskOutput.prototype.getStdout;
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let reached=false;
  let execution;
  TaskOutput.prototype.getStdout=async function(...args){
    if(this.stdoutToFile) {
      reached=true;
      enter();
      await gate;
    }
    return originalGetStdout.apply(this,args);
  };
  try{
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    assert.ok(bash,'original CLI Bash tool must be registered');
    // A real spawned Node process with its own shell and TaskOutput fd.
    // No synthetic tool promise: the real ChildProcess close handler
    // reaches TaskOutput.getStdout() only after process-tree termination.
    const command='node -e "require(\'node:fs\').writeFileSync(\'started.txt\',\'yes\');setInterval(()=>{},1000)"';
    execution=bash.execute({command,timeout_ms:16000});
    await untilExists(join(root,'started.txt'));
    assert.equal(getShellLifecycleStatus().liveShellCommands,1);
    const cleanup=cleanupLiveShellCommands();
    const reachedResult=await Promise.race([
      entered.then(()=>true),
      new Promise(resolve=>setTimeout(()=>resolve(false),6500)),
    ]);
    assert.equal(reachedResult,true,
      'real Bash must enter its async file-output finalizer after cancellation');
    assert.equal(reached,true);
    assert.equal(getShellLifecycleStatus().liveShellCommands,1,
      'the original shell owner must remain live until TaskOutput settles');
    const race=await Promise.race([
      cleanup.then(()=> 'incorrect early cleanup'),
      new Promise(resolve=>setTimeout(()=>resolve('waiting'),120)),
    ]);
    assert.equal(race,'waiting',
      'cleanup cannot release session lock before native Bash file output finalization');
    release();
    await cleanup;
    const result=await execution;
    assert.equal(result.exit_code,1);
    assert.match(result.error,/terminated while releasing its owning CLI session/);
    assert.equal(await readFile(join(root,'started.txt'),'utf8'),'yes');
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
    await cleanupLiveShellCommands();
  }finally{
    release();
    TaskOutput.prototype.getStdout=originalGetStdout;
    await cleanupLiveShellCommands().catch(()=>{});
    await execution?.catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
