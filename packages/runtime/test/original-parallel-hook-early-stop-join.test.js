import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentLoop} from '../src/agent-loop.js';
import {ToolRegistry} from '../src/tool-registry.js';
import {aggregateHookResults} from '../src/legacy-tools/pretooluse-hook-aggregation.js';

function defer(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
async function waitForFile(file){
  for(let i=0;i<170;i++){
    try{return await readFile(file,'utf8');}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await new Promise(done=>setTimeout(done,25));
  }
  throw new Error('An original parallel native Hook did not start: '+file);
}

test('original PreToolUse aggregation iterator.return() joins already-started sibling outcomes',async()=>{
  const gate=defer();
  const outcomes=[
    Promise.resolve({additionalContexts:['fast original Hook completed']}),
    gate.promise,
  ];
  const iterator=aggregateHookResults(outcomes);
  const first=await iterator.next();
  assert.deepEqual(first.value,{additionalContexts:['fast original Hook completed']});
  let returned=false;
  const closing=iterator.return().then(()=>{returned=true;});
  try{
    await Promise.resolve();
    assert.equal(returned,false,
      'closing source PreToolUse generator cannot abandon a running matching command');
  }finally{
    gate.resolve({});
  }
  await closing;
  assert.equal(returned,true);
});

test('real AgentLoop preserves completed Write and joins parallel PostToolUse sibling after continue:false',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-original-parallel-stop-'));
  const fast=join(root,'fast-done.txt');
  const started=join(root,'slow-started.txt');
  const released=join(root,'release.txt');
  const finished=join(root,'slow-finished.txt');
  let run,settled=false,modelCalls=0,toolCalls=0;
  try{
    await writeFile(join(root,'stop.cjs'),
      "const fs=require('node:fs');"+
      "fs.writeFileSync('fast-done.txt','stopped');"+
      "console.log(JSON.stringify({continue:false,stopReason:'stop after all native Hook cleanup'}));");
    await writeFile(join(root,'slow.cjs'),
      "const fs=require('node:fs');"+
      "fs.writeFileSync('slow-started.txt','started');"+
      "const pending=setInterval(()=>{if(fs.existsSync('release.txt')){"+
      "clearInterval(pending);fs.writeFileSync('slow-finished.txt','done');"+
      "console.log(JSON.stringify({hookSpecificOutput:{"+
      "hookEventName:'PostToolUse',additionalContext:'late parallel context'}}));"+
      "}},25);");
    const tools=new ToolRegistry();
    tools.register({name:'Write',description:'Source original committed tool',
      execute:async({content})=>{
        toolCalls++;
        await writeFile(join(root,'result.txt'),content);
        return 'tool mapped result '+toolCalls;
      },
    });
    const checkpoints=[];
    const loop=new AgentLoop({
      tools,hookWorkspace:root,maxTurns:3,
      model:{async *stream(){
        modelCalls++;
        if(modelCalls>1)throw new Error('PostToolUse continue:false incorrectly replayed the model');
        yield {type:'tool_use',id:'post-stop-join',name:'Write',
          input:{content:'side effect retained'}};
        yield {type:'message_end',stopReason:'tool_use'};
      }},
      postToolUseHooks:[
        {matcher:'Write',type:'command',command:'node stop.cjs',timeout:8},
        {matcher:'Write',type:'command',command:'node slow.cjs',timeout:8},
      ],
      permissionPolicy:async()=>({behavior:'allow'}),
      onSessionCheckpoint:async item=>{checkpoints.push(item.kind);},
    });
    run=loop.run({input:'Write exactly once'});
    void run.then(()=>{settled=true;},()=>{settled=true;});
    await Promise.all([waitForFile(fast),waitForFile(started)]);
    // This is a deterministic gate: the second real spawned Hook has
    // started, but cannot return until our test creates release.txt.
    assert.equal(settled,false,
      'a source continue:false may not release Query while a parallel Hook remains alive');
    assert.equal(loop.active,true,
      'the original CLI session lock still owns all launched Hook commands');
    assert.equal(toolCalls,1);
    assert.equal(modelCalls,1);
    assert.equal(await readFile(join(root,'result.txt'),'utf8'),'side effect retained');
    await writeFile(released,'release');
    const result=await run;
    assert.equal(await readFile(finished,'utf8'),'done');
    assert.equal(settled,true);
    assert.equal(loop.active,false);
    assert.equal(result.stopReason,'hook_stopped');
    assert.equal(result.stopMessage,'stop after all native Hook cleanup');
    assert.equal(result.messages.at(-1).content[0].content,'tool mapped result 1');
    assert.ok(checkpoints.includes('tool_pending'));
    assert.ok(checkpoints.includes('tool'));
    assert.equal(modelCalls,1);
  }finally{
    await writeFile(released,'release').catch(()=>{});
    await run?.catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
