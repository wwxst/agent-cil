import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function inWorkspace(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-cil-source-pre-'));
  try { return await run(cwd); }
  finally { await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('source 2.1.88 PreToolUse continue:false calls authorized tool exactly once and checkpoints full tool_result before stopping', {
  timeout: 20000,
}, async () => {
  await inWorkspace(async cwd => {
    await writeFile(join(cwd, 'stop.cjs'),
      'process.stdout.write(JSON.stringify({continue:false,stopReason:"source stop"}));');
    const controller = new AbortController();
    const tools = new ToolRegistry();
    let calls = 0, requests = 0;
    tools.register({ name: 'Write', description: 'Source-compatible fixture',
      execute: async ({ content }) => {
        calls++;
        await writeFile(join(cwd, 'output.txt'), content);
        return 'complete result #'+calls;
      },
    });
    const loop = new AgentLoop({
      model: { async *stream() {
        requests++;
        if (requests !== 1) throw new Error('No second provider call after Hook stop');
        yield { type:'tool_use', id:'source-stop-write', name:'Write', input:{ content:'once' } };
        yield { type:'message_end', stopReason:'tool_use' };
      } },
      tools, maxTurns:3, hookWorkspace:cwd,
      preToolUseHooks:[{matcher:'Write',type:'command',command:'node stop.cjs',timeout:6}],
      permissionPolicy:async()=>({behavior:'allow'}),
    });
    const checkpoints=[];
    loop.on('turnFinished', event => checkpoints.push(event));
    const result=await loop.run({input:'write once',signal:controller.signal});
    assert.equal(calls,1,'count actual execute invocations, not Hook command invocations');
    assert.equal(requests,1,'no further provider call after saved tool result');
    assert.equal(await readFile(join(cwd,'output.txt'),'utf8'),'once');
    assert.equal(result.stopReason,'hook_stopped');
    assert.equal(result.stopMessage,'source stop');
    assert.equal(result.messages[1].content[0].id,'source-stop-write');
    const modelUserBlocks=result.messages[2].content;
    assert.equal(modelUserBlocks[0].tool_use_id,'source-stop-write');
    assert.equal(modelUserBlocks[0].content,'complete result #1');
    assert.equal(modelUserBlocks[0].is_error,undefined);
    assert.match(modelUserBlocks[1].text,/PreToolUse:Write hook stopped continuation: source stop/);
    assert.equal(checkpoints.length,1);
    assert.deepEqual(checkpoints[0].committedMessages,result.messages,
      'complete assistant + full successful result + Hook stop are checkpointed together');
  });
});

test('source 2.1.88 PreToolUse denied plus continue:false cannot run tool even if Hook requests stopping', {
  timeout: 20000,
}, async () => {
  await inWorkspace(async cwd => {
    await writeFile(join(cwd,'deny.cjs'),
      'process.stdout.write(JSON.stringify({continue:false,stopReason:"deny stop",'+
      'hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny"}}));');
    const tools=new ToolRegistry();
    let calls=0,requests=0;
    tools.register({name:'Write',description:'Denied write fixture',
      execute:async()=>{calls++;await writeFile(join(cwd,'denied.txt'),'never');return 'unexpected';},
    });
    const loop=new AgentLoop({
      model:{async *stream({messages}) {
        requests++;
        if(requests===1){
          yield {type:'tool_use',id:'blocked-write',name:'Write',input:{content:'bad'}};
          yield {type:'message_end',stopReason:'tool_use'};
        }else{
          const result=messages.at(-1).content[0];
          assert.equal(result.tool_use_id,'blocked-write');
          assert.equal(result.is_error,true);
          yield {type:'text_delta',text:'The tool was denied.'};
          yield {type:'message_end',stopReason:'end_turn'};
        }
      }},
      tools,maxTurns:3,hookWorkspace:cwd,
      preToolUseHooks:[{matcher:'Write',type:'command',command:'node deny.cjs',timeout:6}],
      permissionPolicy:async()=>({behavior:'allow'}),
    });
    const result=await loop.run({input:'attempt a denied write'});
    assert.equal(calls,0,'deny takes precedence over continue:false');
    await assert.rejects(stat(join(cwd,'denied.txt')),{code:'ENOENT'});
    assert.equal(result.messages[2].content[0].is_error,true);
    assert.equal(requests,2);
  });
});
