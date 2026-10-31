import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('original native Tool.call structured_output survives as separate session attachment without corrupting tool_result', async () => {
  const tools = new ToolRegistry();
  let calls = 0, requests = 0;
  tools.register({
    name:'Produce', description:'Produce structured output',
    call:async()=>{
      calls++;
      return {data:'plain tool success', structured_output:{
        status:'ok', findings:[{file:'a.txt',risk:'low'}],
      }};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  const loop = new AgentLoop({
    tools, maxTurns:3, permissionPolicy:async()=>({behavior:'allow'}),
    model:{async *stream({messages}) {
      requests++;
      if(requests===1){
        yield {type:'tool_use',id:'structured-1',name:'Produce',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      } else {
        assert.equal(requests,2);
        assert.deepEqual(messages.at(-1).content,[{
          type:'tool_result',tool_use_id:'structured-1',content:'plain tool success',
        }],'original structured_output must NOT be sent as an extra API block');
        yield {type:'text_delta',text:'done'};
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const events=[];loop.on('toolAttachment',event=>events.push(event));
  const checkpoints=[];loop.on('turnFinished',e=>{
    if(e.committedMessages)checkpoints.push(e.committedMessages);
  });
  const result=await loop.run({input:'produce structured result'});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(calls,1);
  assert.equal(requests,2);
  assert.equal(result.messages[2].content[0].content,'plain tool success');
  assert.equal(result.messages[2].content[0].is_error,undefined);
  assert.equal(events.length,1);
  assert.equal(events[0].toolUseId,'structured-1');
  assert.deepEqual(events[0].attachment,{
    type:'structured_output',data:{status:'ok',findings:[{file:'a.txt',risk:'low'}]},
  });
  assert.deepEqual(result.toolAttachments,events);
  assert.deepEqual(checkpoints[0],result.messages.slice(0,3));
});

test('legacy Tool.call returning no structured_output still creates no synthetic attachment', async()=>{
  const tools=new ToolRegistry();
  tools.register({name:'Plain',description:'Plain native tool',
    call:async()=>({data:'okay'}),
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  let round=0;
  const loop=new AgentLoop({tools,permissionPolicy:async()=>({behavior:'allow'}),
    model:{async *stream(){
      round++;
      if(round===1){
        yield {type:'tool_use',id:'plain-1',name:'Plain',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const result=await loop.run({input:'test'});
  assert.equal(result.toolAttachments,undefined);
  assert.equal(result.messages[2].content[0].content,'okay');
});
