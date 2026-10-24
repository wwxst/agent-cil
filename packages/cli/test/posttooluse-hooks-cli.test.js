import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
function frame(type, data={}) {
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
}
function toolStream(name,id,input) {
  return frame('message_start',{message:{usage:{input_tokens:22}}})+
    frame('content_block_start',{index:0,content_block:{type:'tool_use',id,name,input:{}}})+
    frame('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:7}})+
    frame('message_stop');
}
const finalStream=()=>frame('message_start',{message:{usage:{input_tokens:20}}})+
  frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
  frame('content_block_delta',{index:0,delta:{type:'text_delta',text:'Post-Hook verified.'}})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:3}})+
  frame('message_stop');

test('real installed CLI invokes original PostToolUse after Write and failure Hook after throwing Edit', {
  timeout:60000,
}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-posthooks-'));
  async function scenario(name,input,expectedFailure) {
    const incoming=[];
    const server=createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      incoming.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(incoming.length===1 ? toolStream(name,'hook-result-'+name,input):finalStream());
    });
    let child,watchdog;
    try {
      await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
      });
      child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
        '--cwd',root,'--allow-edits','--max-turns','3','--max-retries','0',
        '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
        '--hooks-file',join(root,'hooks.json'),'Use tool once.'],
      {env:{...process.env,DEEPSEEK_API_KEY:'only-local-fixture'},stdio:['ignore','pipe','pipe']});
      const out=[],err=[];
      child.stdout.on('data',x=>out.push(x));child.stderr.on('data',x=>err.push(x));
      watchdog=setTimeout(()=>child.kill('SIGKILL'),15000);
      const [code,signal]=await new Promise((resolve,reject)=>{
        child.once('error',reject);child.once('close',(code,signal)=>resolve([code,signal]));
      });
      const output=Buffer.concat(out).toString('utf8');
      const errors=Buffer.concat(err).toString('utf8');
      assert.equal(signal,null,errors);
      assert.equal(code,0,errors);
      assert.match(output,/Post-Hook verified/);
      assert.equal(incoming.length,2);
      const result=incoming[1].messages.at(-1).content[0];
      assert.equal(result.tool_use_id,'hook-result-'+name);
      assert.equal(result.is_error===true,expectedFailure);
      const afterToolResults=incoming[1].messages.at(-1).content.slice(1);
      assert.equal(afterToolResults.length,1,
        'source normalizeAttachmentForAPI must include exactly one meta Hook context');
      assert.equal(afterToolResults[0].type,'text');
      const originalEventName=expectedFailure ? 'PostToolUseFailure' : 'PostToolUse';
      assert.ok(afterToolResults[0].text.startsWith('<system-reminder>' + String.fromCharCode(10)));
      assert.match(afterToolResults[0].text,
        new RegExp(originalEventName+':'+name+' hook additional context:'));
      assert.match(afterToolResults[0].text,
        expectedFailure ? /Tool error seen/ : /Post success note/);
      // Original source hides success/error UI attachments from API.
      assert.doesNotMatch(afterToolResults[0].text,/hook_success|hook_error_during_execution/);
      return result;
    } finally {
      if(watchdog)clearTimeout(watchdog);
      if(child&&child.exitCode===null&&!child.killed)child.kill('SIGKILL');
      server.closeAllConnections?.();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    }
  }
  try {
    // Hooks read native original event JSON from stdin and record it on disk.
    await writeFile(join(root,'posthook.cjs'),
      "let v='';process.stdin.on('data',x=>v+=x);process.stdin.on('end',()=>{"+
      "const data=JSON.parse(v);require('node:fs').writeFileSync('success-hook.json',JSON.stringify(data));"+
      "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Post success note'}}));});");
    await writeFile(join(root,'failurehook.cjs'),
      "let v='';process.stdin.on('data',x=>v+=x);process.stdin.on('end',()=>{"+
      "const data=JSON.parse(v);require('node:fs').writeFileSync('failed-hook.json',JSON.stringify(data));"+
      "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUseFailure',additionalContext:'Tool error seen'}}));});");
    await writeFile(join(root,'hooks.json'),JSON.stringify({hooks:{
      PostToolUse:[{matcher:'Write',hooks:[{type:'command',command:'node posthook.cjs',timeout:7}]}],
      PostToolUseFailure:[{matcher:'Edit',hooks:[{type:'command',command:'node failurehook.cjs',timeout:7}]}],
    }}));
    await scenario('Write',{file_path:'made.txt',content:'persisted'},false);
    assert.equal(await readFile(join(root,'made.txt'),'utf8'),'persisted');
    const post=JSON.parse(await readFile(join(root,'success-hook.json'),'utf8'));
    assert.equal(post.hook_event_name,'PostToolUse');
    assert.equal(post.tool_use_id,'hook-result-Write');
    assert.deepEqual(post.tool_input,{file_path:'made.txt',content:'persisted'});
    assert.equal(post.tool_response.written,true);
    await assert.rejects(stat(join(root,'failed-hook.json')),{code:'ENOENT'});

    await scenario('Edit',{
      file_path:'made.txt',old_string:'text that does not exist',new_string:'bad',
    },true);
    assert.equal(await readFile(join(root,'made.txt'),'utf8'),'persisted');
    const failure=JSON.parse(await readFile(join(root,'failed-hook.json'),'utf8'));
    assert.equal(failure.hook_event_name,'PostToolUseFailure');
    assert.equal(failure.tool_use_id,'hook-result-Edit');
    assert.match(failure.error,/not found|not unique|match|occurrence/i);
    assert.equal(failure.is_interrupt,false);
    const postAfter=JSON.parse(await readFile(join(root,'success-hook.json'),'utf8'));
    assert.equal(postAfter.tool_use_id,'hook-result-Write');
  } finally {
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});
