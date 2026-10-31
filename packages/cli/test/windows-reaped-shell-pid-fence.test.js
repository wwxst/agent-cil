import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createBuiltinTools,cleanupLiveShellCommands,getShellLifecycleStatus,
} from '../src/index.js';
import {TaskOutput} from '../src/legacy-task-output.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('Windows cleanup trusts the completed Job Object receipt instead of taskkilling an exited shell PID',{
  skip:process.platform!=='win32' &&
    'PID-reuse fence must use the real Windows Node ChildProcess and SystemRoot',
  timeout:20000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-win-reaped-pid-'));
  const oldRoot=process.env.SystemRoot;
  const oldGetStdout=TaskOutput.prototype.getStdout;
  let arrive,release;
  const entered=new Promise(resolve=>{arrive=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  let execution;
  try{
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    let gated=false;
    TaskOutput.prototype.getStdout=async function(...args){
      if(this.stdoutToFile && !gated){
        gated=true;
        arrive();
        await gate;
      }
      return oldGetStdout.apply(this,args);
    };
    // A real one-shot Windows cmd.exe/Node Bash process, not a synthetic
    // child or a mocked taskkill. The TaskOutput gate begins ONLY after
    // the native ChildProcess 'exit' and 'close' events have fired.
    execution=bash.execute({
      command:'"'+process.execPath.replaceAll('"','')+
        '" -e "process.stdout.write(\'SHELL_ALREADY_EXITED\')"',
      timeout_ms:10000,
    });
    await Promise.race([
      entered,
      pause(8000).then(()=>{throw new Error('ChildProcess close never entered TaskOutput finalizer');}),
    ]);
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:1,pendingKillBackstops:0,
    });
    // If the old PID is still passed to taskkill, the bogus SystemRoot
    // forces ENOENT. The Job Object owner has already confirmed all members
    // exited before its ChildProcess 'close'; cleanup must use that durable
    // ownership receipt and wait for the existing TaskOutput finalizer.
    process.env.SystemRoot=join(root,'must-never-invoke-taskkill');
    const cleanup=cleanupLiveShellCommands();
    const result=cleanup.then(()=>({ok:true}),error=>({ok:false,error}));
    assert.equal((await Promise.race([result,pause(120).then(()=>null)])),null,
      'owner cleanup also awaits the original TaskOutput finalization barrier');
    release();
    const ended=await result;
    assert.equal(ended.ok,true,
      'the native Job Object already confirmed the descendant tree is empty');
    assert.doesNotMatch(String(ended.error??''),/ENOENT|taskkill exit/,
      'an exited shell must not be passed to taskkill by stale numeric PID');
    const bashResult=await execution;
    // The shell exited at OS level, but cleanupLiveShellCommands() set
    // shutdownRequested before its delayed TaskOutput completion. Preserve
    // the existing CLI contract: a session-owned shutdown is NOT success.
    assert.equal(bashResult.exit_code,1);
    assert.match(bashResult.error,/terminated while releasing its owning CLI session/);
    assert.match(bashResult.stdout,/SHELL_ALREADY_EXITED/);
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
    await cleanupLiveShellCommands();
  }finally{
    release();
    TaskOutput.prototype.getStdout=oldGetStdout;
    if(oldRoot===undefined)delete process.env.SystemRoot;
    else process.env.SystemRoot=oldRoot;
    await cleanupLiveShellCommands().catch(()=>{});
    await execution?.catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
});
