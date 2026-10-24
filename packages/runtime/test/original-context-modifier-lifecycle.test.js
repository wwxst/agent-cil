import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('2.1.88 native contextModifier propagates through source serial StreamingToolExecutor to next Tool.call and permission, without leaking into model tool_result', {
  timeout:20000,
},async()=>{
  const tools=new ToolRegistry();
  let firstCalls=0,secondCalls=0,requests=0,modifierCalls=0;
  const policyContexts=[];
  const nativeContexts=[];
  tools.register({
    name:'Initialize',description:'Source ToolUseContext modifier',
    call:async (_input,context)=>{
      firstCalls++;
      nativeContexts.push({tool:'Initialize',marker:context.sourceMarker});
      return {
        data:'initialized',
        contextModifier: original=>{
          modifierCalls++;
          assert.equal(original.sourceMarker,undefined);
          assert.equal(typeof original.executeAdapter,'function');
          return {...original,sourceMarker:'source-context-v1',
            sourceCounter:(original.sourceCounter||0)+1};
        },
      };
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  tools.register({
    name:'Consume',description:'Reads original updated ToolUseContext',
    call:async (_input,context)=>{
      secondCalls++;
      nativeContexts.push({tool:'Consume',marker:context.sourceMarker,count:context.sourceCounter});
      assert.equal(context.sourceMarker,'source-context-v1');
      assert.equal(context.sourceCounter,1);
      return {data:'consumed source-context-v1'};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  const loop=new AgentLoop({
    tools,
    permissionPolicy:async ({name,phase,toolUseContext})=>{
      if(phase==='initial') policyContexts.push({name,marker:toolUseContext?.sourceMarker});
      if(name==='Consume' && toolUseContext?.sourceMarker!=='source-context-v1'){
        return {behavior:'deny',reason:'Original updated context missing'};
      }
      return {behavior:'allow'};
    },
    model:{async *stream({messages}){
      requests++;
      if(requests===1){
        yield {type:'tool_use',id:'ctx-1',name:'Initialize',input:{}};
        yield {type:'tool_use',id:'ctx-2',name:'Consume',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        assert.equal(requests,2);
        assert.deepEqual(messages.at(-1).content,[
          {type:'tool_result',tool_use_id:'ctx-1',content:'initialized'},
          {type:'tool_result',tool_use_id:'ctx-2',content:'consumed source-context-v1'},
        ]);
        yield {type:'text_delta',text:'confirmed'};
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
    maxTurns:3,
  });
  const checkpoints=[];
  loop.on('turnFinished',e=>{if(e.committedMessages)checkpoints.push(e.committedMessages)});
  const result=await loop.run({input:'initialize then consume'});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(firstCalls,1);
  assert.equal(secondCalls,1);
  assert.equal(modifierCalls,1);
  assert.equal(requests,2);
  assert.deepEqual(nativeContexts,[
    {tool:'Initialize',marker:undefined},
    {tool:'Consume',marker:'source-context-v1',count:1},
  ]);
  assert.deepEqual(policyContexts,[
    {name:'Initialize',marker:undefined},
    {name:'Consume',marker:'source-context-v1'},
  ]);
  assert.deepEqual(checkpoints[0],result.messages.slice(0,3));
});

test('source contextModifier is applied in tool order across multiple serial tools', {
  timeout:20000,
},async()=>{
  const tools=new ToolRegistry();
  const observed=[];
  for(const i of [1,2,3]){
    tools.register({
      name:'Step'+i,description:'Original serial modifier step '+i,
      call:async(_input,context)=>{
        observed.push({step:i,scope:context.scope??[]});
        return {data:'step '+i,
          contextModifier:old=>({...old,scope:[...(old.scope??[]),i]})};
      },
      mapToolResultToToolResultBlockParam:(data,id)=>({
        type:'tool_result',tool_use_id:id,content:data,
      }),
    });
  }
  let requests=0;
  const loop=new AgentLoop({
    tools,maxTurns:2,permissionPolicy:async()=>({behavior:'allow'}),
    model:{async *stream({messages}){
      requests++;
      if(requests===1){
        for(const i of [1,2,3])yield{
          type:'tool_use',id:'step-'+i,name:'Step'+i,input:{},
        };
        yield {type:'message_end',stopReason:'tool_use'};
      } else {
        assert.deepEqual(messages.at(-1).content.map(b=>b.tool_use_id),
          ['step-1','step-2','step-3']);
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const result=await loop.run({input:'steps'});
  assert.equal(result.stopReason,'end_turn');
  assert.deepEqual(observed,[
    {step:1,scope:[]},{step:2,scope:[1]},{step:3,scope:[1,2]},
  ]);
  assert.equal(requests,2);
});

test('invalid source contextModifier yields tool error and independent sibling still executes under normal permission',async()=>{
  const tools=new ToolRegistry();
  let skipped=0;
  tools.register({
    name:'Invalid',description:'Bad native context modifier',
    call:async()=>({data:'value',contextModifier:{wrong:true}}),
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  tools.register({
    name:'Next',description:'After invalid context modifier',
    call:async()=>{skipped++;return {data:'should be refused'};},
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  let rounds=0;
  const loop=new AgentLoop({
    tools,maxTurns:2,permissionPolicy:async()=>({behavior:'allow'}),
    model:{async *stream({messages}){
      rounds++;
      if(rounds===1){
        yield {type:'tool_use',id:'invalid',name:'Invalid',input:{}};
        yield {type:'tool_use',id:'next',name:'Next',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        const first=messages.at(-1).content[0];
        assert.equal(first.tool_use_id,'invalid');
        assert.equal(first.is_error,true);
        assert.match(first.content,/contextModifier must be a function/);
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const result=await loop.run({input:'invalid modifier'});
  assert.equal(result.stopReason,'end_turn');
  // Source StreamingToolExecutor only cascades sibling cancellation for
  // Bash tool errors. A non-Bash error cannot silently disable an unrelated
  // authorized sibling; invalid modifier never modifies its context.
  assert.equal(skipped,1);
  assert.equal(rounds,2);
});
