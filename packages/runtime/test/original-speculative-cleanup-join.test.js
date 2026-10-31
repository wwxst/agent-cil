import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AgentLoop} from '../src/agent-loop.js';
import {ToolRegistry} from '../src/tool-registry.js';

// Original 2.1.88 StreamingToolExecutor.discard() tombstones results, but
// Query must also join in-flight Node tool promises after aborting their
// own signal. Read/Glob/Grep can already be running while SSE is incomplete.
function defer(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
async function exerciseFailure({checkpointFailure=false}){
  const entered=defer(),abortObserved=defer(),releaseCleanup=defer();
  let cleaned=false,toolInvocations=0,providerCalls=0,providerMessageRequests=0;
  const reg=new ToolRegistry();
  reg.register({
    name:'Read',description:'Original read-only streaming tool',
    inputSchema:{type:'object',properties:{file_path:{type:'string'}},
      required:['file_path'],additionalProperties:false},
    isConcurrencySafe:()=>true,canRunDuringStream:true,
    execute:async(_,{signal})=>{
      toolInvocations++;
      entered.resolve();
      if(!signal.aborted) {
        await new Promise(resolve=>{
          signal.addEventListener('abort',resolve,{once:true});
        });
      }
      abortObserved.resolve();
      // Represent a real, still-in-progress async file close / directory
      // scanner teardown. The caller MUST NOT receive a model failure nor
      // reuse this AgentLoop until the actual cleanup completes.
      await releaseCleanup.promise;
      cleaned=true;
      throw new Error('read cancelled after descriptor cleanup');
    },
  });
  const model={async *stream(){
    providerCalls++;
    yield {type:'tool_use',id:'read-before-model-end',name:'Read',
      input:{file_path:'existing.txt'}};
    await entered.promise;
    if(checkpointFailure) {
      yield {type:'message_end',stopReason:'tool_use'};
    }else{
      throw new Error('injected malformed/aborted provider stream');
    }
  }};
  const permissionPolicy=async({phase})=>({
    behavior:'allow',reason:'Read-only workspace file',
  });
  Object.defineProperty(permissionPolicy,'supportsStreamingPreflight',{value:true});
  const error=checkpointFailure?/injected pending tool journal fsync failure/:
    /injected malformed\/aborted provider stream/;
  const loop=new AgentLoop({
    model,tools:reg,permissionPolicy,
    onSessionCheckpoint:async ({kind})=>{
      if(kind==='tool_pending' && checkpointFailure)
        throw new Error('injected pending tool journal fsync failure');
    },
  });
  let settled=false;
  const run=loop.run({input:'Read the file'}).then(value=>{
    settled=true;return value;
  },failure=>{settled=true;throw failure;});
  try {
    await abortObserved.promise;
    // discard() already signalled cancellation but the original started
    // generator has not finished its cleanup. This is a deterministic
    // verification of the actual close-order boundary, not a timer race.
    assert.equal(cleaned,false);
    assert.equal(settled,false,
      'Query must not expose an aborted tool round before file cleanup');
    assert.equal(loop.active,true,
      'a second interactive prompt may not overlap stale tool cleanup');
    assert.equal(toolInvocations,1);
    assert.equal(providerCalls,1);
    await assert.rejects(loop.run({input:'second prompt'}),
      /already has an active run/);
  } finally {
    releaseCleanup.resolve();
  }
  await assert.rejects(run,error);
  assert.equal(cleaned,true);
  assert.equal(loop.active,false);
  assert.equal(providerCalls,1,'no model retry may race stale read cleanup');
  assert.equal(toolInvocations,1);
  assert.equal(providerMessageRequests,0);
}

test('streaming SSE failure joins actual speculative Read cleanup before ending AgentLoop', {
  timeout:18000,
},async()=>exerciseFailure({checkpointFailure:false}));

test('tool_pending fsync failure joins speculative Read cleanup before releasing Session owner', {
  timeout:18000,
},async()=>exerciseFailure({checkpointFailure:true}));
