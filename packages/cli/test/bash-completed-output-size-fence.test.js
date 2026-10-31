import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,truncate,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createBuiltinTools,cleanupLiveShellCommands,getShellLifecycleStatus,
} from '../src/index.js';
import {TaskOutput,isReadableInternalTaskOutputPath}
  from '../src/legacy-task-output.js';
import {AgentLoop} from '../../runtime/src/agent-loop.js';

const shellCommand=() =>
  '"'+process.execPath.replaceAll('"','')+
  '" -e "process.stdout.write(\'NATIVE_BASH_COMPLETE_OUTPUT\')"';

async function exerciseCompletedFileMutation({mutation,throughLoop=false}){
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bash-final-size-'));
  const sessionId=randomUUID();
  const original=TaskOutput.prototype.getStdout;
  let touched=0;
  let filePath,requests=0,started=0;
  const checkpoints=[];
  let backup;
  try{
    TaskOutput.prototype.getStdout=async function(...args){
      if(this.stdoutToFile){
        touched++;
        filePath=this.path;
        // runShellCommand already called native TaskOutput.flush() and
        // captured its completed-size witness BEFORE this point.
        if(mutation==='truncate')await truncate(this.path,1);
        else {
          backup=this.path+'.moved';
          await rename(this.path,backup);
          await writeFile(this.path,'X'.repeat('NATIVE_BASH_COMPLETE_OUTPUT'.length));
        }
      }
      return original.apply(this,args);
    };
    const tools=await createBuiltinTools({
      workspace:root,taskSession:{workspace:root,sessionId},
    });
    if(throughLoop){
      const model={async *stream(){
        requests++;
        yield {type:'tool_use',id:'native-bash-should-not-map',
          name:'Bash',input:{command:shellCommand(),timeout_ms:12000}};
        yield {type:'message_end',stopReason:'tool_use'};
      }};
      const loop=new AgentLoop({
        model,tools,maxTurns:3,
        permissionPolicy:async()=>({behavior:'allow'}),
        onToolExecutionStart:async()=>{started++;},
        onSessionCheckpoint:async checkpoint=>{
          checkpoints.push(checkpoint.kind);
        },
      });
      await assert.rejects(loop.run({input:'Run the real shell'}),error=>
        error?.name==='TaskOutputPersistenceError' &&
        /Bash TaskOutput (file length changed|file was replaced)/.test(error.message));
      assert.equal(requests,1,'invalid native output must block the next provider round');
      assert.equal(started,1,'original Bash crossed the durable executing boundary');
      assert.ok(checkpoints.includes('tool_pending'));
      assert.equal(checkpoints.includes('tool'),false,
        'no valid final Bash tool_result can be committed for changed bytes');
    }else{
      await assert.rejects(tools.get('Bash').execute({
        command:shellCommand(),timeout_ms:12000,
      }),error=>error?.name==='TaskOutputPersistenceError' &&
        /Bash TaskOutput (file length changed|file was replaced)/.test(error.message));
    }
    assert.equal(touched,1,'the real Bash reached its output finalizer');
    assert.equal(isReadableInternalTaskOutputPath(root,filePath,sessionId),false);
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
  }finally{
    TaskOutput.prototype.getStdout=original;
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

test('real Bash native output truncated after flush cannot return partial successful stdout',{
  timeout:24000,
},()=>exerciseCompletedFileMutation({mutation:'truncate'}));

test('real Bash output replaced with an equal-size file never confers trusted Read authorization',{
  timeout:24000,
},()=>exerciseCompletedFileMutation({mutation:'replace'}));

test('AgentLoop holds the next provider turn and tool-result checkpoint when native Bash output shrinks',{
  timeout:25000,
},()=>exerciseCompletedFileMutation({mutation:'truncate',throughLoop:true}));
