import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHookPermissionDecision } from '../src/legacy-tools/pretooluse-core.js';

const tool={name:'Write'};
const assistant={role:'assistant',content:[]};
function context(check) {
  return {
    trustedCliDefaultPermission:true,
    checkRuleBasedPermissions:check,
  };
}
test('original hook allow bypasses only the CLI default prompt, not explicit deny',async()=>{
  const input={file_path:'test.txt',content:'source'};
  let calls=0;
  const canUseTool=async()=>{calls++;return {behavior:'ask'};};
  const rule=context(async()=>({behavior:'ask',reason:'This tool modifies workspace files.'}));
  const resolved=await resolveHookPermissionDecision({behavior:'allow'},tool,input,
    rule,canUseTool,assistant,'t1');
  assert.equal(resolved.decision.behavior,'allow');
  assert.equal(calls,0);
  rule.checkRuleBasedPermissions=async()=>({behavior:'deny',reason:'Protected target'});
  const denied=await resolveHookPermissionDecision({behavior:'allow'},tool,input,
    rule,canUseTool,assistant,'t1');
  assert.equal(denied.decision.behavior,'deny');
  assert.equal(calls,0);
});
test('original hook ask forces default permission path with final rewritten input',async()=>{
  let observed;
  const updated={file_path:'new.txt',content:'approved'};
  const result=await resolveHookPermissionDecision({behavior:'ask',updatedInput:updated},tool,
    {file_path:'old.txt',content:'old'},context(async()=>null),
    async(_tool,input,_ctx,_assistant,_id,force)=>{
      observed={input,force};
      return {behavior:'ask'};
    },assistant,'t2');
  assert.equal(result.decision.behavior,'ask');
  assert.deepEqual(result.input,updated);
  assert.equal(observed.force.behavior,'ask');
  assert.deepEqual(observed.input,updated);
});
