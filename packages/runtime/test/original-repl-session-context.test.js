import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

function registerStateTools(tools, events) {
  tools.register({
    name:'OpenState',description:'Tool that changes original ToolUseContext',
    call:async()=>({
      data:'state open',
      contextModifier:previous=>({...previous, sessionPermission:'granted-in-session'}),
    }),
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  tools.register({
    name:'UseState',description:'A second tool that reads the updated context',
    call:async(_input,context)=>{
      events.push({name:'UseState',marker:context.sessionPermission});
      return {data:'state is '+String(context.sessionPermission)};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
}

test('original REPL retains committed ToolUseContext into next AgentLoop.run with prior messages', {
  timeout:20000,
},async()=>{
  const tools=new ToolRegistry();
  const events=[],policy=[];
  registerStateTools(tools,events);
  let requests=0;
  const loop=new AgentLoop({
    tools,maxTurns:3,
    permissionPolicy:async({name,phase,toolUseContext})=>{
      if(phase==='initial')policy.push([name,toolUseContext?.sessionPermission]);
      if(name==='UseState'&&toolUseContext?.sessionPermission!=='granted-in-session'){
        return {behavior:'deny',reason:'Missing original REPL tool state'};
      }
      return {behavior:'allow'};
    },
    model:{async *stream({messages}){
      requests++;
      const last=messages.at(-1);
      const prompt=last?.role==='user' && typeof last.content==='string' ? last.content : '';
      if(prompt==='open'){
        yield {type:'tool_use',id:'open-1',name:'OpenState',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else if(prompt==='continue'){
        yield {type:'tool_use',id:'use-1',name:'UseState',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        yield {type:'text_delta',text:'finished prompt'};
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const first=await loop.run({input:'open'});
  assert.equal(first.stopReason,'end_turn');
  assert.equal(events.length,0);
  assert.equal(first.messages[2].content[0].content,'state open');
  const second=await loop.run({
    messages:structuredClone(first.messages),input:'continue',
  });
  assert.equal(second.stopReason,'end_turn');
  assert.deepEqual(events,[{name:'UseState',marker:'granted-in-session'}]);
  assert.deepEqual(policy,[
    ['OpenState',undefined],['UseState','granted-in-session'],
  ]);
  assert.equal(second.messages.at(-3).content[0].tool_use_id,'use-1');
  assert.equal(second.messages.at(-2).content[0].content,'state is granted-in-session');
  assert.equal(requests,4);
});

test('source REPL context persists after later model network failure only for a completed tool-result checkpoint', {
  timeout:20000,
},async()=>{
  const tools=new ToolRegistry();
  const events=[];
  registerStateTools(tools,events);
  let failFollowingModel=true, modelRequests=0;
  const loop=new AgentLoop({
    tools,maxTurns:4,
    permissionPolicy:async({name,toolUseContext})=>{
      if(name==='UseState' && toolUseContext?.sessionPermission!=='granted-in-session')
        return {behavior:'deny',reason:'Lost checkpoint ToolUseContext'};
      return {behavior:'allow'};
    },
    model:{async *stream({messages}){
      modelRequests++;
      const last=messages.at(-1);
      if(last?.role==='user' && last.content==='open'){
        yield {type:'tool_use',id:'open-failure-1',name:'OpenState',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else if(failFollowingModel){
        throw new Error('network failed after successful tool checkpoint');
      }else if(last?.role==='user' && last.content==='continue'){
        yield {type:'tool_use',id:'use-recovered',name:'UseState',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        yield {type:'text_delta',text:'recovered'};
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  let completedCheckpoint;
  loop.on('turnFinished',event=>{
    if(event.committedMessages)completedCheckpoint=event.committedMessages;
  });
  await assert.rejects(loop.run({input:'open'}),
    /network failed after successful tool checkpoint/);
  assert.equal(completedCheckpoint[2].content[0].content,'state open');
  failFollowingModel=false;
  const result=await loop.run({
    messages:structuredClone(completedCheckpoint),
    input:'continue',
  });
  assert.equal(result.stopReason,'end_turn');
  assert.deepEqual(events,[{name:'UseState',marker:'granted-in-session'}]);
  assert.equal(result.messages.at(-2).content[0].content,
    'state is granted-in-session');
  assert.equal(modelRequests,4);
});

test('original REPL ToolUseContext is cleared when a caller forks a different transcript', {
  timeout:20000,
},async()=>{
  const tools=new ToolRegistry();
  const events=[];
  registerStateTools(tools,events);
  const loop=new AgentLoop({
    tools,maxTurns:2,
    permissionPolicy:async({name,toolUseContext})=>
      ({behavior:name==='UseState' && toolUseContext?.sessionPermission
        !=='granted-in-session'?'deny':'allow',reason:'No session inheritance'}),
    model:{async *stream({messages}){
      const last=messages.at(-1);
      const prompt=last?.role==='user' && last.content;
      if(prompt==='open'){
        yield {type:'tool_use',id:'fork-open',name:'OpenState',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else if(prompt==='unrelated'){
        yield {type:'tool_use',id:'fork-attempt',name:'UseState',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const first=await loop.run({input:'open'});
  assert.equal(first.stopReason,'end_turn');
  // Same AgentLoop object, but history differs: fresh session/fork. A
  // permission-sensitive context modifier must not leak into it.
  const fork=await loop.run({
    messages:[{role:'user',content:'forked independent history'}],
    input:'unrelated',
  });
  assert.equal(fork.messages.at(-2).content[0].is_error,true);
  assert.equal(events.length,0);
});
