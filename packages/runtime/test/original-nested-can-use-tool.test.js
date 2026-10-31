import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function runNested({
  nestedPolicy=()=>({behavior:'allow'}), approvalHandler,
  nestedForceDecision, fakeNestedTool=false, childInput={path:'ok.txt'},
  childValidate, childCheckPermissions,
}={}) {
  const tools=new ToolRegistry();
  let hostCalls=0,childCalls=0,requests=0,approvalCalls=0;
  let nestedDecision,modelMessage;
  const policyChecks=[],approvalRequests=[];
  tools.register({
    name:'Write',description:'Nested target that performs a test side effect',
    inputSchema:{type:'object',properties:{path:{type:'string'}},
      required:['path'],additionalProperties:false},
    validateInput:childValidate,
    checkPermissions:childCheckPermissions,
    call:async input=>{
      childCalls++;
      return {data:'child wrote '+input.path};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  const registeredChild=tools.get('Write');
  tools.register({
    name:'Host',description:'Calls original canUseTool for nested request',
    call:async (_input, context, canUseTool, assistantMessage)=>{
      hostCalls++;
      const proposed=fakeNestedTool ? { ...registeredChild } : registeredChild;
      nestedDecision=await canUseTool(
        proposed,childInput,context,assistantMessage,'nested-write',
        nestedForceDecision,
      );
      if(nestedDecision.behavior==='allow'){
        await registeredChild.call(nestedDecision.updatedInput??childInput);
      }
      return {data:'nested '+nestedDecision.behavior};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  const loop=new AgentLoop({
    tools,maxTurns:3,
    permissionPolicy:async({name,phase,input,toolUseId})=>{
      policyChecks.push({name,phase,input,toolUseId});
      if(name==='Host')return {behavior:'allow'};
      return nestedPolicy({name,phase,input,toolUseId});
    },
    ...(approvalHandler===undefined?{}:{approvalHandler:async req=>{
      approvalCalls++;
      approvalRequests.push(req);
      return approvalHandler(req);
    }}),
    model:{async *stream({messages}){
      requests++;
      if(requests===1){
        yield {type:'tool_use',id:'host-1',name:'Host',input:{}};
        yield {type:'message_end',stopReason:'tool_use'};
      }else{
        modelMessage=messages.at(-1);
        assert.deepEqual(modelMessage.content.map(x=>x.tool_use_id),['host-1']);
        assert.equal(modelMessage.content[0].content,'nested '+nestedDecision.behavior);
        yield {type:'text_delta',text:'finished'};
        yield {type:'message_end',stopReason:'end_turn'};
      }
    }},
  });
  const emitted=[];
  loop.on('permissionRequired', e=>emitted.push(e));
  const result=await loop.run({input:'host makes authorized nested request'});
  assert.equal(result.stopReason,'end_turn');
  assert.equal(hostCalls,1);
  assert.equal(requests,2);
  return {nestedDecision,childCalls,policyChecks,approvalCalls,
    approvalRequests,emitted,result,modelMessage};
}

test('original canUseTool: a registered nested tool passes real policy and tool.checkPermissions before child executes',async()=>{
  let toolChecks=0;
  const r=await runNested({
    childCheckPermissions:async()=>{toolChecks++;return {behavior:'allow'};},
  });
  assert.equal(r.nestedDecision.behavior,'allow');
  assert.equal(r.childCalls,1);
  assert.equal(toolChecks,1);
  assert.deepEqual(r.policyChecks.map(x=>x.name),['Host','Write']);
  assert.equal(r.policyChecks[1].toolUseId,'nested-write');
  assert.equal(r.approvalCalls,0);
});
test('original canUseTool: explicit nested deny overrides parent allow and forced allow, never executes child',async()=>{
  const r=await runNested({
    nestedPolicy:()=>({behavior:'deny',reason:'Explicit Write deny'}),
    nestedForceDecision:{behavior:'allow'},
  });
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.match(r.nestedDecision.reason,/Explicit Write deny/);
  assert.equal(r.childCalls,0);
  assert.equal(r.approvalCalls,0);
  assert.equal(r.modelMessage.content[0].content,'nested deny');
});
test('original canUseTool: unknown or forged nested tool definition cannot inherit parent authority',async()=>{
  const r=await runNested({fakeNestedTool:true});
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.equal(r.childCalls,0);
  assert.deepEqual(r.policyChecks.map(x=>x.name),['Host']);
});
test('original canUseTool: nested ask with no approval handler stays denied',async()=>{
  const r=await runNested({nestedPolicy:()=>({behavior:'ask',reason:'Confirm nested Write'})});
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.equal(r.childCalls,0);
  assert.equal(r.emitted.length,1);
  assert.equal(r.emitted[0].nested,true);
  assert.equal(r.emitted[0].toolUseId,'nested-write');
});
test('2.1.304 defaultToNo survives nested ask and reaches the host approval handler', async () => {
  const r = await runNested({
    nestedPolicy: () => ({
      behavior: 'ask',
      reason: 'Review nested destructive operation.',
      defaultToNo: true,
    }),
    approvalHandler: async request => {
      assert.equal(request.defaultToNo, true);
      return { approved: false, reason: 'Declined nested operation.' };
    },
  });
  assert.equal(r.nestedDecision.behavior, 'deny');
  assert.equal(r.approvalRequests[0].defaultToNo, true);
  assert.equal(r.emitted[0].defaultToNo, true);
  assert.equal(r.childCalls, 0);
});
test('original canUseTool: explicit nested ask requires real approval and a second policy check',async()=>{
  const r=await runNested({
    nestedPolicy:()=>({behavior:'ask',reason:'Confirm nested Write'}),
    approvalHandler:async()=>({approved:true,acceptFeedback:'Acknowledged nested request'}),
  });
  assert.equal(r.nestedDecision.behavior,'allow');
  assert.equal(r.nestedDecision.acceptFeedback,'Acknowledged nested request');
  assert.equal(r.childCalls,1);
  assert.equal(r.approvalCalls,1);
  assert.equal(r.approvalRequests[0].nested,true);
  assert.deepEqual(r.policyChecks.map(x=>x.phase),
    ['initial','nested','nested-post-approval']);
});
test('original canUseTool: approval cannot bypass a permission rule that changed during the dialog',async()=>{
  let called=0;
  const r=await runNested({
    nestedPolicy:()=>({behavior:++called===1?'ask':'deny',
      reason:called===1?'Confirm nested Write':'Rule tightened'}),
    approvalHandler:async()=>({approved:true}),
  });
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.match(r.nestedDecision.reason,/changed during approval/);
  assert.equal(r.childCalls,0);
  assert.equal(r.approvalCalls,1);
});
test('original canUseTool: forced ask cannot bypass approval when baseline rule says allow',async()=>{
  const r=await runNested({
    nestedForceDecision:{behavior:'ask',reason:'Forced human review'},
  });
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.equal(r.childCalls,0);
  assert.equal(r.emitted[0].reason,'Forced human review');
});
test('original canUseTool: tool updatedInput is revalidated and globally reauthorized before return',async()=>{
  let checks=0;
  const r=await runNested({
    childCheckPermissions:async input=>{
      checks++;
      return input.path==='first.txt'
        ? {behavior:'allow',updatedInput:{path:'rewritten.txt'}}
        : {behavior:'allow'};
    },
    childInput:{path:'first.txt'},
    nestedPolicy:({input})=>({behavior: input.path==='rewritten.txt'?'allow':'allow'}),
  });
  assert.equal(r.nestedDecision.behavior,'allow');
  assert.deepEqual(r.nestedDecision.updatedInput,{path:'rewritten.txt'});
  assert.equal(r.childCalls,1);
  assert.equal(checks,2);
  assert.deepEqual(r.policyChecks.map(x=>x.phase),
    ['initial','nested','nested-recheck']);
});
test('original canUseTool: invalid nested updatedInput denied before child call',async()=>{
  const r=await runNested({
    nestedPolicy:()=>({behavior:'allow',updatedInput:{path:42}}),
  });
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.match(r.nestedDecision.reason,/Invalid nested tool updatedInput/);
  assert.equal(r.childCalls,0);
});

test('original canUseTool: tool-specific deny overrides a global allow and forced allow',async()=>{
  const r=await runNested({
    nestedForceDecision:{behavior:'allow'},
    childCheckPermissions:async()=>({behavior:'deny',reason:'Tool-specific restriction'}),
  });
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.match(r.nestedDecision.reason,/Tool-specific restriction/);
  assert.equal(r.childCalls,0);
});
test('original canUseTool: schema validation denies nested arguments before any permission or execution',async()=>{
  const r=await runNested({childInput:{path:123}});
  assert.equal(r.nestedDecision.behavior,'deny');
  assert.match(r.nestedDecision.reason,/Invalid nested tool input/);
  assert.equal(r.childCalls,0);
  assert.deepEqual(r.policyChecks.map(x=>x.name),['Host']);
});
test('original canUseTool: abort during nested approval propagates interrupt and never executes child or commits an incomplete batch',{
  timeout:15000,
},async()=>{
  const controller=new AbortController();
  const tools=new ToolRegistry();
  let parentCalls=0,childCalls=0,providerCalls=0,approvals=0;
  tools.register({name:'Child',description:'Nested side-effect fixture',
    call:async()=>{childCalls++;return {data:'unexpected'};},
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  const child=tools.get('Child');
  tools.register({name:'Parent',description:'Nested approval abort fixture',
    call:async(_input,context,canUseTool,assistantMessage)=>{
      parentCalls++;
      const result=await canUseTool(child,{},context,assistantMessage,'nested-abort');
      if(result.behavior==='allow')await child.call({});
      return {data:result.behavior};
    },
    mapToolResultToToolResultBlockParam:(data,id)=>({
      type:'tool_result',tool_use_id:id,content:data,
    }),
  });
  const loop=new AgentLoop({
    tools,maxTurns:3,
    permissionPolicy:async({name})=>({behavior:name==='Parent'?'allow':'ask',
      reason:'Confirm nested request'}),
    approvalHandler:async()=>{
      approvals++;
      controller.abort(new Error('Cancelled inside nested approval'));
      return {approved:true};
    },
    model:{async *stream(){
      providerCalls++;
      yield {type:'tool_use',id:'parent-abort',name:'Parent',input:{}};
      yield {type:'message_end',stopReason:'tool_use'};
    }},
  });
  const statuses=[],checkpoints=[];
  loop.on('toolCallFinished',event=>statuses.push(event));
  loop.on('turnFinished',event=>checkpoints.push(event));
  await assert.rejects(loop.run({
    input:'request nested approval',signal:controller.signal,
  }),/Cancelled inside nested approval/);
  assert.equal(parentCalls,1);
  assert.equal(childCalls,0);
  assert.equal(approvals,1);
  assert.equal(providerCalls,1);
  assert.equal(checkpoints.length,0);
  assert.equal(statuses.filter(x=>x.toolUseId==='parent-abort' && x.interrupted).length,1);
  assert.equal(loop.active,false);
});
