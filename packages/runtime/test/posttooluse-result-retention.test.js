import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function fixture(run) {
  const workspace=await mkdtemp(join(tmpdir(),'agent-cil-post-retention-'));
  try {return await run(workspace);}
  finally {await rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
function modelFor(name,id,expectedError) {
  let rounds=0;
  return {async *stream({messages}) {
    rounds++;
    if(rounds===1) {
      yield {type:'tool_use',id,name,input:{}};
      yield {type:'message_end',stopReason:'tool_use'};
    } else {
      assert.equal(rounds,2);
      const block=messages.at(-1).content[0];
      assert.equal(block.tool_use_id,id);
      assert.equal(block.is_error===true,expectedError);
      yield {type:'text_delta',text:'model completed after tool'};
      yield {type:'message_end',stopReason:'end_turn'};
    }
  }};
}
test('2.1.88 PostToolUse attachment survives without mutating successful result', {
  timeout:18000,
},async()=>{
  await fixture(async workspace=>{
    await writeFile(join(workspace,'post.cjs'),
      "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{"+
      "const x=JSON.parse(s);require('node:fs').writeFileSync('post-event.json',s);"+
      "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'remember this'}}));});");
    const tools=new ToolRegistry();
    let calls=0;
    tools.register({name:'Save',description:'Save fixture',
      call:async()=>{calls++;return {data:{saved:true}};},
      mapToolResultToToolResultBlockParam:(data,id)=>({
        type:'tool_result',tool_use_id:id,content:JSON.stringify(data),
      }),
    });
    const loop=new AgentLoop({model:modelFor('Save','successful-call',false),tools,
      permissionPolicy:async()=>({behavior:'allow'}),hookWorkspace:workspace,
      postToolUseHooks:[{matcher:'Save',type:'command',command:'node post.cjs',timeout:5}],
    });
    const updates=[];loop.on('hookMessage',event=>updates.push(event));
    const result=await loop.run({input:'save once'});
    assert.equal(result.stopReason,'end_turn');
    assert.equal(calls,1);
    assert.equal(result.messages[2].content[0].content,JSON.stringify({saved:true}));
    assert.equal(updates.length,1);
    assert.equal(updates[0].toolUseId,'successful-call');
    assert.equal(updates[0].message.attachment.type,'hook_additional_context');
    assert.deepEqual(result.hookMessages,updates);
    const persistedInput=JSON.parse(await readFile(join(workspace,'post-event.json'),'utf8'));
    assert.equal(persistedInput.hook_event_name,'PostToolUse');
    assert.equal(persistedInput.tool_response.saved,true);
  });
});
test('original PostToolUseFailure observes real tool.call error, does not replace tool_result', {
  timeout:18000,
},async()=>{
  await fixture(async workspace=>{
    await writeFile(join(workspace,'failure.cjs'),
      "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{"+
      "require('node:fs').writeFileSync('error-event.json',s);"+
      "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUseFailure',additionalContext:'failure context'}}));});");
    const tools=new ToolRegistry();
    tools.register({name:'Crash',description:'A failing fixture',execute:async()=>{
      throw new Error('Distinct tool execution failure');
    }});
    const loop=new AgentLoop({model:modelFor('Crash','crashed-call',true),tools,
      permissionPolicy:async()=>({behavior:'allow'}),hookWorkspace:workspace,
      postToolUseFailureHooks:[{matcher:'Crash',type:'command',command:'node failure.cjs',timeout:5}],
    });
    const result=await loop.run({input:'call crashing tool'});
    assert.match(result.messages[2].content[0].content,/Distinct tool execution failure/);
    assert.equal(result.hookMessages.length,1);
    assert.equal(result.hookMessages[0].message.attachment.type,'hook_additional_context');
    const input=JSON.parse(await readFile(join(workspace,'error-event.json'),'utf8'));
    assert.equal(input.hook_event_name,'PostToolUseFailure');
    assert.equal(input.is_interrupt,false);
    assert.match(input.error,/Distinct tool execution failure/);
  });
});
test('nonblocking PostToolUse Hook failure preserves already successful mapped result', {
  timeout:18000,
},async()=>{
  await fixture(async workspace=>{
    await writeFile(join(workspace,'broken.cjs'),
      "console.log('{invalid JSON');");
    const tools=new ToolRegistry();
    tools.register({name:'Fixed',description:'Fixture',execute:async()=> 'original, must survive'});
    const loop=new AgentLoop({model:modelFor('Fixed','fixed-call',false),tools,
      permissionPolicy:async()=>({behavior:'allow'}),hookWorkspace:workspace,
      postToolUseHooks:[{matcher:'Fixed',type:'command',command:'node broken.cjs',timeout:5}],
    });
    const result=await loop.run({input:'fixed'});
    assert.equal(result.messages[2].content[0].content,'original, must survive');
    assert.equal(result.hookMessages.length,1);
    assert.equal(result.hookMessages[0].message.attachment.type,'hook_error_during_execution');
  });
});
