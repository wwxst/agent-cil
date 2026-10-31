import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry, ToolRegistryError } from '../src/tool-registry.js';

async function executeOriginalHookCase({
  requireCanUseTool = false,
  interactiveTool = false,
  permission = 'ask',
  approval,
} = {}) {
  const cwd=await mkdtemp(join(tmpdir(),'agent-cil-require-can-use-tool-'));
  try {
    await writeFile(join(cwd,'hook-allow.cjs'),
      'process.stdout.write(JSON.stringify({hookSpecificOutput:{'+
      'hookEventName:"PreToolUse",permissionDecision:"allow"}}));');
    const tools=new ToolRegistry();
    let calls=0,approvals=0,requests=0,checks=0,permissionNeeded=0;
    tools.register({
      name:'Write',description:'Native original Hook permission fixture',
      requiresUserInteraction:()=>interactiveTool,
      execute:async()=>{calls++;return 'written once';},
    });
    const permissionPolicy=async()=>{
      checks++;
      return {behavior:permission,reason:permission==='ask'
        ?'This tool modifies workspace files.':'Explicit mandatory deny'};
    };
    // Only first-party policy's default prompt is Hook-bypassable. A
    // random untrusted ask rule must never gain this privilege.
    permissionPolicy.isBuiltinCliPolicy=true;
    const loop=new AgentLoop({
      tools,permissionPolicy,requireCanUseTool,
      hookWorkspace:cwd,
      preToolUseHooks:[{matcher:'Write',type:'command',command:'node hook-allow.cjs',timeout:8}],
      approvalHandler:async()=>{
        approvals++;
        return {approved:approval===true};
      },
      model:{async *stream({messages}){
        requests++;
        if(requests===1){
          yield {type:'tool_use',id:'gate-write',name:'Write',input:{}};
          yield {type:'message_end',stopReason:'tool_use'};
        } else {
          const b=messages.at(-1).content[0];
          assert.equal(b.tool_use_id,'gate-write');
          assert.equal(b.is_error===true,calls===0);
          yield {type:'text_delta',text:'finished'};
          yield {type:'message_end',stopReason:'end_turn'};
        }
      }},
    });
    loop.on('permissionRequired',()=>{permissionNeeded++;});
    const result=await loop.run({input:'Hook allow canUseTool gate'});
    return {result,calls,approvals,requests,checks,permissionNeeded};
  } finally {
    await rm(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}

test('source Hook allow may bypass only trusted default permission prompt in ordinary parent CLI', {
  timeout:15000,
},async()=>{
  const r=await executeOriginalHookCase();
  assert.equal(r.calls,1);
  assert.equal(r.approvals,0);
  assert.equal(r.permissionNeeded,0);
  assert.equal(r.requests,2);
  assert.equal(r.result.messages[2].content[0].content,'written once');
});

test('source requireCanUseTool=true routes Hook allow through real ask and a denial prevents the tool call', {
  timeout:15000,
},async()=>{
  const r=await executeOriginalHookCase({requireCanUseTool:true,approval:false});
  assert.equal(r.calls,0);
  assert.equal(r.approvals,1);
  assert.equal(r.permissionNeeded,1);
  assert.equal(r.requests,2);
  assert.equal(r.result.messages[2].content[0].is_error,true);
});

test('source requireCanUseTool=true permits the exact approved input after post-approval recheck', {
  timeout:15000,
},async()=>{
  const r=await executeOriginalHookCase({requireCanUseTool:true,approval:true});
  assert.equal(r.calls,1);
  assert.equal(r.approvals,1);
  assert.equal(r.permissionNeeded,1);
  assert.ok(r.checks>=2,'permission must be rechecked after approval');
  assert.equal(r.result.messages[2].content[0].is_error,undefined);
});

test('source requiresUserInteraction() makes even non-forked Hook allow request approval', {
  timeout:15000,
},async()=>{
  const r=await executeOriginalHookCase({interactiveTool:true,approval:false});
  assert.equal(r.calls,0);
  assert.equal(r.approvals,1);
  assert.equal(r.permissionNeeded,1);
});

test('source requireCanUseTool and tool.requiresUserInteraction never override global explicit deny', {
  timeout:15000,
},async()=>{
  const r=await executeOriginalHookCase({
    requireCanUseTool:true,interactiveTool:true,permission:'deny',approval:true,
  });
  assert.equal(r.calls,0);
  assert.equal(r.approvals,0);
  assert.equal(r.permissionNeeded,0);
  assert.equal(r.result.messages[2].content[0].is_error,true);
});

test('original registration and runtime reject malformed requireCanUseTool contracts',()=>{
  const tools=new ToolRegistry();
  assert.throws(()=>tools.register({
    name:'Invalid',description:'bad',requiresUserInteraction:true,
    execute:async()=>null,
  }),ToolRegistryError);
  assert.throws(()=>new AgentLoop({
    model:{async *stream(){}},tools,requireCanUseTool:'true',
  }),/requireCanUseTool must be a boolean/);
});
