import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+'\ndata: '+
  JSON.stringify({type,...data})+'\n\n';
function emitTool(id,name,input){
  return frame('message_start',{message:{usage:{input_tokens:45}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name,input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:14}})+
    frame('message_stop');
}
function finalAnswer(){
  return frame('message_start',{message:{usage:{input_tokens:60}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'Background task was started, inspected and stopped.',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:18}})+
    frame('message_stop');
}
function toolResult(messages,id){
  for(const message of messages??[]){
    if(message.role!=='user'||!Array.isArray(message.content))continue;
    for(const block of message.content) {
      if(block?.type==='tool_result'&&block.tool_use_id===id) {
        if(typeof block.content==='string'){
          try{return JSON.parse(block.content);}catch{return block.content;}
        }
        return block.content;
      }
    }
  }
  return null;
}
async function optional(path){
  try{return await readFile(path,'utf8');}
  catch(e){if(e.code==='ENOENT')return '';throw e;}
}

test('packed CLI model executes Bash background, TaskOutput, Read live log and TaskStop with durable Session',{
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-background-model-'));
  const sessionId=randomUUID(),command='node bg-agent-task.cjs';
  const beatFile=join(root,'bg-heartbeats.txt');
  let requests=0,taskId,reportedOutput,stopped=false;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);
    requests++;
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(requests===1){
      res.end(emitTool('tool-bg-first','Bash',{
        command,run_in_background:true,timeout_ms:20000,
      }));
    }else if(requests===2){
      const result=toolResult(body.messages,'tool-bg-first');
      taskId=result?.backgroundTaskId;
      reportedOutput=result?.outputFilePath;
      res.end(taskId?emitTool('tool-bg-output','TaskOutput',{
        task_id:taskId,block:false,
      }):finalAnswer());
    }else if(requests===3){
      const output=toolResult(body.messages,'tool-bg-output');
      if(output?.task?.task_id!==taskId ||
         output?.retrieval_status!=='not_ready') {
        res.end(finalAnswer());return;
      }
      // Wait until the process can actually write before Read inspects
      // its growing native output file. This is not permission bypass:
      // the CLI Read tool must verify the original session-owned FD.
      await new Promise(resolve=>setTimeout(resolve,300));
      res.end(emitTool('tool-bg-read','Read',{
        file_path:reportedOutput,offset:0,limit:1,
      }));
    }else if(requests===4) {
      const readResult=toolResult(body.messages,'tool-bg-read');
      if(typeof readResult!=='string' || !readResult.includes('BACKGROUND_MODEL_BASH_STARTED')) {
        res.end(finalAnswer());return;
      }
      res.end(emitTool('tool-bg-stop','TaskStop',{task_id:taskId}));
    }else {
      const stoppedResult=toolResult(body.messages,'tool-bg-stop');
      stopped=stoppedResult?.task_id===taskId;
      res.end(finalAnswer());
    }
  });
  let child,closed,watchdog;
  try {
    await writeFile(join(root,'bg-agent-task.cjs'),[
      "const fs=require('node:fs');",
      "process.stdout.write('BACKGROUND_MODEL_BASH_STARTED\\n');",
      "setInterval(()=>{",
      " fs.appendFileSync('bg-heartbeats.txt','tick\\n');",
      " process.stdout.write('LOG_TICK\\n');",
      "},45);",
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--session-id',sessionId,'--max-turns','6',
      '--max-retries','0','--compact-threshold','0',
      '--allowedTools','Bash('+command+')',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Start a background Bash command; inspect status then stop it'],{
      env:{...process.env,DEEPSEEK_API_KEY:'only-local-bash-background'},
      stdio:['ignore','pipe','pipe'],
    });
    const stdout=[],stderr=[];
    child.stdout.on('data',b=>stdout.push(b));
    child.stderr.on('data',b=>stderr.push(b));
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),28000);
    const result=await closed;
    const output=Buffer.concat(stdout).toString('utf8');
    const errors=Buffer.concat(stderr).toString('utf8');
    assert.equal(result.signal,null,errors);
    assert.equal(result.code,0,errors+output);
    assert.equal(requests,5,'expected Bash, TaskOutput, Read, TaskStop, final response');
    assert.match(output,/Background task was started, inspected and stopped/);
    assert.ok(stopped,'real TaskStop result was returned to the model');
    assert.match(taskId,/^[0-9a-f-]{36}$/i);
    assert.ok(reportedOutput.endsWith(taskId+'.output'));
    assert.match(await optional(reportedOutput),/BACKGROUND_MODEL_BASH_STARTED/);
    const after=await optional(beatFile);
    assert.ok(after.length>0,'background process really ran while model made follow-up requests');
    await new Promise(resolve=>setTimeout(resolve,430));
    assert.equal(await optional(beatFile),after,
      'TaskStop and CLI close must release background process descendants');
    const journal=(await readFile(join(root,'.agent-cil','sessions',
      sessionId,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.filter(x=>x.kind==='tool').length,4,
      'all four tool rounds must be durably committed');
    assert.match(JSON.stringify(journal),/tool-bg-read/);
    assert.match(JSON.stringify(journal),/tool-bg-stop/);
  } finally {
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
});