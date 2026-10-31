import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { executePostToolUseFailureHooks } from '../src/legacy-tools/posttooluse-node-compat.js';

async function tempWorkspace(fn) {
  const workspace=await mkdtemp(join(tmpdir(),'agent-cil-source-post-abort-'));
  try{return await fn(workspace);}
  finally{await rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}

test('old PostToolUseFailure gets is_interrupt=true in original executeHooks stdin contract', {
  timeout: 12000,
}, async () => {
  await tempWorkspace(async workspace => {
    await writeFile(join(workspace,'observe.cjs'),
      "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{"+
      "require('node:fs').writeFileSync('observed.json',s);"+
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUseFailure'}}));});");
    const context={
      workspace,getAppState:()=>({toolPermissionContext:{mode:'default'}}),
      toolHooks:{PostToolUseFailure:[{matcher:'Work',type:'command',
        command:'node observe.cjs',timeout:6}]},
    };
    const output=[];
    for await(const event of executePostToolUseFailureHooks(
      'Work','abort-id',{file_path:'a.txt'},'User cancelled',context,
      true,'default',new AbortController().signal,
    ))output.push(event);
    assert.equal(output.length,1);
    const data=JSON.parse(await readFile(join(workspace,'observed.json'),'utf8'));
    assert.equal(data.hook_event_name,'PostToolUseFailure');
    assert.equal(data.tool_use_id,'abort-id');
    assert.equal(data.is_interrupt,true);
    assert.equal(data.error,'User cancelled');
  });
});

test('active original tool cancellation emits terminal tool status and cancelled failure Hook before propagating abort', {
  timeout: 15000,
}, async () => {
  await tempWorkspace(async workspace => {
    let started,release;
    const callStarted=new Promise(resolve=>{started=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    const tools=new ToolRegistry();
    let calls=0,modelRequests=0;
    tools.register({name:'Work',description:'Cancelable fixture',
      execute:async()=>{
        calls++;started();
        await gate;
        return 'must never become a committed tool_result';
      },
    });
    const controller=new AbortController();
    const loop=new AgentLoop({
      model:{async *stream(){
        modelRequests++;
        yield {type:'tool_use',id:'aborted-tool',name:'Work',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
      maxTurns:3,tools,hookWorkspace:workspace,
      toolResultStorage:{
        workspace,directory:join(workspace,'.agent-cil','sessions','cancel','tool-results'),
      },
      permissionPolicy:async()=>({behavior:'allow'}),
      postToolUseFailureHooks:[{matcher:'Work',type:'command',
        command:'node cancelled.cjs',timeout:6}],
    });
    const finished=[],hookMessages=[],checkpoints=[];
    loop.on('toolCallFinished',event=>finished.push(event));
    loop.on('hookMessage',event=>hookMessages.push(event));
    loop.on('turnFinished',event=>checkpoints.push(event));
    await writeFile(join(workspace,'cancelled.cjs'),
      "require('node:fs').writeFileSync('should-not-run.txt','bad');");
    const pending=loop.run({input:'cancel work',signal:controller.signal});
    await callStarted;
    controller.abort(new Error('User cancelled Work'));
    release();
    await assert.rejects(pending,/User cancelled Work/);
    assert.equal(calls,1);
    assert.equal(modelRequests,1);
    assert.equal(loop.active,false);
    assert.equal(finished.length,1);
    assert.equal(finished[0].toolUseId,'aborted-tool');
    assert.equal(finished[0].interrupted,true);
    assert.equal(finished[0].isError,true);
    assert.equal(checkpoints.length,0,
      'aborted partially-complete round cannot overwrite resumable history');
    assert.ok(hookMessages.some(x=>x.message?.attachment?.type==='hook_cancelled'));
    await assert.rejects(stat(join(workspace,'should-not-run.txt')),{code:'ENOENT'});
  });
});
