import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function runCase({ ask = false, updatedInput, initialUserModified = false }) {
  const tools=new ToolRegistry();
  let invoked=0,observed,approvalCalls=0,rounds=0;
  tools.register({
    name:'Edit',description:'Original tool.call permission context',
    inputSchema:{type:'object',properties:{content:{type:'string'}},
      required:['content'],additionalProperties:false},
    call:async (input,context)=>{
      invoked++;
      observed={input,modified:context.userModified};
      return {data:{input,modified:context.userModified}};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:JSON.stringify(data),
    }),
  });
  const loop=new AgentLoop({
    tools,
    approvalHandler:async()=>{
      approvalCalls++;
      return {approved:true,...(updatedInput ? {updatedInput}: {})};
    },
    permissionPolicy:async ({phase})=>{
      if(ask && phase==='initial')return {behavior:'ask',reason:'needs approval'};
      return {behavior:'allow',userModified:initialUserModified};
    },
    model:{async *stream({messages}) {
      rounds++;
      if(rounds===1) {
        yield {type:'tool_use',id:'edit-use',name:'Edit',input:{content:'original'}};
        yield {type:'message_end',stopReason:'tool_use'};
      } else {
        const result=messages.at(-1).content[0];
        assert.equal(result.tool_use_id,'edit-use');
        assert.deepEqual(JSON.parse(result.content),{
          input:observed.input,modified:observed.modified,
        });
        yield {type:'text_delta',text:'ok'};
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const result=await loop.run({input:'edit once'});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(invoked,1);
  assert.equal(rounds,2);
  return {observed,approvalCalls,result};
}

test('old Tool.call userModified defaults false for unchanged policy allow',async()=>{
  const {observed,approvalCalls}=await runCase({});
  assert.deepEqual(observed,{input:{content:'original'},modified:false});
  assert.equal(approvalCalls,0);
});
test('old Tool.call userModified true for policy-provided explicit marker',async()=>{
  const {observed}=await runCase({initialUserModified:true});
  assert.equal(observed.modified,true);
});
test('old Tool.call userModified false when user approves without changing input',async()=>{
  const {observed,approvalCalls}=await runCase({ask:true});
  assert.equal(observed.modified,false);
  assert.equal(approvalCalls,1);
});
test('old Tool.call userModified true when approval changes validated input',async()=>{
  const {observed,approvalCalls}=await runCase({
    ask:true,updatedInput:{content:'user edited this'},
  });
  assert.deepEqual(observed,{input:{content:'user edited this'},modified:true});
  assert.equal(approvalCalls,1);
});
