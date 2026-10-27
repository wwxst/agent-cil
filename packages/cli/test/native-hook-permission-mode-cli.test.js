import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
function frame(type,data={}) {
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
}
function toolStream(id){
  return frame('message_start',{message:{usage:{input_tokens:12}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name:'Write',input:{}}})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({
        file_path:'mode-probe.txt',content:'written by CLI',
      })}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:5}})+
    frame('message_stop');
}
function answerStream(){
  return frame('message_start',{message:{usage:{input_tokens:13}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{type:'text_delta',text:'finished'}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:4}})+
    frame('message_stop');
}

async function checkMode({allowEdits}){
  const root=await mkdtemp(join(tmpdir(),'agent-cil-hook-mode-'));
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(requests.length===1?toolStream('mode-write'):answerStream());
  });
  let child,timer;
  try {
    const hookScript=join(root,'mode-hook.cjs');
    await writeFile(hookScript,
      "const fs=require('fs');let data='';"+
      "process.stdin.on('data',x=>data+=x);"+
      "process.stdin.on('end',()=>{const input=JSON.parse(data);"+
      "fs.appendFileSync('hook-modes.jsonl',JSON.stringify({event:input.hook_event_name,"+
      "mode:input.permission_mode})+'\\n');"+
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{"+
      "hookEventName:input.hook_event_name,"+
      "permissionDecision:input.hook_event_name==='PreToolUse'?'allow':undefined}}));});"
    );
    const settings=join(root,'hooks.json');
    await writeFile(settings,JSON.stringify({hooks:{
      PreToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node mode-hook.cjs',timeout:8,
      }]}],
      PostToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node mode-hook.cjs',timeout:8,
      }]}],
    }}));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-turns','3','--compact-threshold','0',
      '--max-retries','0','--base-url',
      'http://127.0.0.1:'+server.address().port+'/anthropic',
      '--hooks-file',settings,...(allowEdits?['--allow-edits']:[]),
      'Write the probe file'],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-test-only'},
      stdio:['ignore','pipe','pipe'],
    });
    const out=[],err=[];
    child.stdout.on('data',chunk=>out.push(chunk));
    child.stderr.on('data',chunk=>err.push(chunk));
    timer=setTimeout(()=>child.kill('SIGKILL'),17000);
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(c,s)=>resolve([c,s]));
    });
    const output=Buffer.concat(out).toString('utf8')+
      Buffer.concat(err).toString('utf8');
    assert.equal(signal,null,output);
    assert.equal(code,0,output);
    assert.equal(requests.length,2,output);
    assert.equal(await readFile(join(root,'mode-probe.txt'),'utf8'),
      'written by CLI');
    const rows=(await readFile(join(root,'hook-modes.jsonl'),'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows,[
      {event:'PreToolUse',mode:allowEdits?'acceptEdits':'default'},
      {event:'PostToolUse',mode:allowEdits?'acceptEdits':'default'},
    ],'old CLI 2.1.88 getAppState permission mode must reach both native Hooks');
  }finally{
    if(timer)clearTimeout(timer);
    if(child&&child.exitCode===null&&!child.killed)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
test('real CLI default permission mode is supplied to both original tool Hooks',
  {timeout:30000},async()=>checkMode({allowEdits:false}));
test('real CLI acceptEdits mode reaches PreToolUse and PostToolUse without hardcoded default',
  {timeout:30000},async()=>checkMode({allowEdits:true}));
