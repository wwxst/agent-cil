import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function scenario({ rewrite, hook, expectedPath, expectedContent }) {
  const cwd=await mkdtemp(join(tmpdir(),'agent-cil-source-backfill-'));
  let toolCalls=0,modelRounds=0,callInput,hookCommands=[];
  const observed=[];
  const tools=new ToolRegistry();
  try {
    if(hook) {
      await writeFile(join(cwd,'rewrite.cjs'),
        'process.stdout.write(JSON.stringify({hookSpecificOutput:{'+
        'hookEventName:"PreToolUse",permissionDecision:"allow",'+
        'updatedInput:{file_path:"expanded-observable.txt",content:"new-content"}}}));');
      hookCommands=[{type:'command',matcher:'Save',command:'node rewrite.cjs',timeout:6}];
    }
    tools.register({
      name:'Save',description:'Observe without rewriting actual call input',
      inputSchema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'}},
        required:['file_path','content'],additionalProperties:false},
      backfillObservableInput: input => { input.file_path='expanded-observable.txt'; },
      call:async input => {
        toolCalls++;
        callInput=structuredClone(input);
        return {data:{file_path:input.file_path,content:input.content}};
      },
      mapToolResultToToolResultBlockParam:(data,id)=>({
        type:'tool_result',tool_use_id:id,content:JSON.stringify(data),
      }),
    });
    const policy=async ({input,phase})=>{
      observed.push({phase,input:structuredClone(input)});
      if(rewrite && phase==='initial')return {
        behavior:'allow',updatedInput:{file_path:'user-updated.txt',content:'new-content'},
      };
      return {behavior:'allow'};
    };
    const loop=new AgentLoop({
      model:{async *stream({messages}){
        modelRounds++;
        if(modelRounds===1) {
          yield {type:'tool_use',id:'observable-1',name:'Save',
            input:{file_path:'model-relative.txt',content:'original'}};
          yield {type:'message_end',stopReason:'tool_use'};
        } else {
          const block=messages.at(-1).content[0];
          assert.equal(block.tool_use_id,'observable-1');
          assert.deepEqual(JSON.parse(block.content),{file_path:expectedPath,content:expectedContent});
          yield {type:'text_delta',text:'completed'};
          yield {type:'message_end',stopReason:'end_turn'};
        }
      }},
      tools,permissionPolicy:policy,maxTurns:3,
      hookWorkspace:cwd,preToolUseHooks:hookCommands,
    });
    const result=await loop.run({input:'save'});
    assert.equal(result.stopReason,'end_turn');
    assert.equal(toolCalls,1);
    assert.equal(modelRounds,2);
    assert.deepEqual(callInput,{file_path:expectedPath,content:expectedContent});
    assert.equal(result.messages[1].content[0].input.file_path,'model-relative.txt',
      'original model tool_use block must not be mutated by observation backfill');
    assert.ok(observed.length>=1);
    assert.ok(observed.some(x=>x.input.file_path==='expanded-observable.txt'),
      'permission and Hook see only the backfilled observable copy');
  } finally {
    await rm(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}

test('2.1.88 backfillObservableInput expands observable input but not tool.call or transcript',async()=>{
  await scenario({expectedPath:'model-relative.txt',expectedContent:'original'});
});
test('2.1.88 explicit permission updatedInput changes tool.call input, not just observable view',async()=>{
  await scenario({rewrite:true,expectedPath:'user-updated.txt',expectedContent:'new-content'});
});
test('2.1.88 Hook updatedInput retaining expanded file_path restores original path but keeps rewritten content',async()=>{
  await scenario({hook:true,expectedPath:'model-relative.txt',expectedContent:'new-content'});
});
