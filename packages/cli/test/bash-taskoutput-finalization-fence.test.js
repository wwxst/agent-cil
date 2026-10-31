import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinTools,cleanupLiveShellCommands,
  getShellLifecycleStatus} from '../src/index.js';
import {TaskOutput,isReadableInternalTaskOutputPath} from '../src/legacy-task-output.js';
import {AgentLoop} from '../../runtime/src/agent-loop.js';

const makeCommand=large=>
  '"'+process.execPath.replaceAll('"','')+'" -e "'+
    (large?"process.stdout.write('X'.repeat(42000))":
      "process.stdout.write('CLOSE_FINALIZED')")+'"';

async function exerciseCloseFailure({at,large=false,viaAgentLoop=false}) {
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bash-finish-fence-'));
  const sessionId=randomUUID();
  const originalDelete=TaskOutput.prototype.deleteOutputFile;
  const originalRegister=TaskOutput.prototype.registerCompletedOutput;
  let filePath,spawned=0,providerCalls=0;
  let checkpoints=[],started=[];
  try {
    if(at==='delete') {
      TaskOutput.prototype.deleteOutputFile=async function () {
        filePath=this.path;
        throw new Error('injected TaskOutput delete failure');
      };
    } else {
      TaskOutput.prototype.registerCompletedOutput=function () {
        filePath=this.path;
        throw new Error('injected TaskOutput register failure');
      };
    }
    const tools=await createBuiltinTools({
      workspace:root,taskSession:{workspace:root,sessionId},
    });
    const command=makeCommand(large);
    const expected=/Bash TaskOutput finalization failed: injected TaskOutput (delete|register) failure/;
    if(!viaAgentLoop) {
      await assert.rejects(
        tools.get('Bash').execute({command,timeout_ms:10000}),error=>{
          assert.equal(error.name,'TaskOutputPersistenceError');
          assert.match(error.message,expected);
          return true;
        },
      );
    } else {
      const model={async *stream(){
        providerCalls++;
        yield {type:'tool_use',id:'failing-native-bash',name:'Bash',
          input:{command,timeout_ms:10000}};
        yield {type:'message_end',stopReason:'tool_use'};
      }};
      const loop=new AgentLoop({
        model,tools,maxTurns:3,
        permissionPolicy:async()=>({behavior:'allow'}),
        onSessionCheckpoint:async checkpoint=>{checkpoints.push(checkpoint.kind);},
        onToolExecutionStart:async item=>{started.push(item);},
      });
      loop.on('toolCallStarted',()=>{spawned++;});
      await assert.rejects(loop.run({input:'Execute one real shell command'}),error=>{
        assert.equal(error.name,'TaskOutputPersistenceError');
        assert.match(error.message,expected);
        return true;
      });
      assert.equal(providerCalls,1,
        'a failed native output finalization may not start another model request');
      assert.equal(spawned,1);
      assert.equal(started.length,1,'the tool execution transition precedes actual shell effects');
      assert.ok(checkpoints.includes('tool_pending'));
      assert.equal(checkpoints.includes('tool'),false,
        'do not commit a successful/mapped tool result after a fatal output error');
    }
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    },'error is not exposed until the actual Bash process and cleanup finish');
    assert.ok(filePath,'fault injection must reach the final native output stage');
    assert.equal(isReadableInternalTaskOutputPath(root,filePath,sessionId),false,
      'a failed finalization may not authorize the output as a trusted Read target');
  }finally{
    TaskOutput.prototype.deleteOutputFile=originalDelete;
    TaskOutput.prototype.registerCompletedOutput=originalRegister;
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

// Original 2.1.88 Shell.ts/TaskOutput owns the file-mode output until it is
// either retained or deleted. Node EventEmitter does not await an async
// ChildProcess 'close' callback: without the fatal completion fence, an
// exception here becomes an unhandled rejection and the caller hangs.
test('real Bash small-output deletion failure rejects after close instead of stranding its Promise',
  {timeout:20000},async()=>exerciseCloseFailure({at:'delete'}));

test('real Bash large-output registration failure rejects without granting Read permission',
  {timeout:20000},async()=>exerciseCloseFailure({at:'register',large:true}));

test('AgentLoop blocks the second provider request when real Bash output finalization fails',
  {timeout:30000},async()=>exerciseCloseFailure({at:'register',large:true,viaAgentLoop:true}));
