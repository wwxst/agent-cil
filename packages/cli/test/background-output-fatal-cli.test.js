import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openSessionJournal} from '../../runtime/src/legacy-session/session-storage.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+
  '\ndata: '+JSON.stringify({type,...data})+'\n\n';
function toolFrame(id,name,input){
  return frame('message_start',{message:{usage:{input_tokens:24}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name,input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:10}})+
    frame('message_stop');
}
function finalFrame(){
  return frame('message_start',{message:{usage:{input_tokens:15}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'text',text:'',
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'ERROR_WAS_WRONGLY_REPORTED_AS_SUCCESS',
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'}})+frame('message_stop');
}
function mappedResult(messages,id){
  for(const message of messages??[]){
    if(message.role!=='user'||!Array.isArray(message.content))continue;
    for(const block of message.content??[]){
      if(block.type==='tool_result'&&block.tool_use_id===id){
        if(typeof block.content!=='string')return block.content;
        try{return JSON.parse(block.content);}catch{return block.content;}
      }
    }
  }
  return null;
}
async function optional(path){
  try{return await readFile(path,'utf8');}
  catch(error){if(error?.code==='ENOENT')return '';throw error;}
}

test('real installed CLI TaskStop refuses to commit a successful tool result after background Bash output persistence fails',{
  timeout:50000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bg-fatal-installed-'));
  const sessionId=randomUUID();
  const command='node background.cjs';
  const requests=[];
  let backgroundId;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const piece of req)chunks.push(piece);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(requests.length===1){
      res.end(toolFrame('start-real-background','Bash',{
        command,run_in_background:true,timeout_ms:20000,
      }));
    }else if(requests.length===2){
      const result=mappedResult(body.messages,'start-real-background');
      backgroundId=result?.backgroundTaskId;
      res.end(backgroundId?toolFrame('stop-real-background','TaskStop',{
        task_id:backgroundId,
      }):finalFrame());
    }else{
      res.end(finalFrame());
    }
  });
  let child,closed,watchdog;
  try{
    await writeFile(join(root,'background.cjs'),[
      "const fs=require('node:fs');",
      "setInterval(()=>{",
      " fs.appendFileSync('real-background-heartbeat.txt','x');",
      " process.stdout.write('HEARTBEAT\\n');",
      "},35);",
    ].join('\n'));
    // Test-only fault at the actual installed package's original TaskOutput
    // finalizer, NOT a fake tool or synthetic model-facing result.
    const installedIndex=await realpath(cli);
    const moduleUrl=pathToFileURL(join(dirname(installedIndex),
      'legacy-task-output.js')).href;
    const preloader=join(root,'inject-finalizer.mjs');
    await writeFile(preloader,[
      'const {TaskOutput}=await import('+JSON.stringify(moduleUrl)+');',
      'TaskOutput.prototype.getStdout=async function(){',
      " const failure=new Error('INJECTED_NATIVE_TASK_OUTPUT_IO_FAILURE');",
      " failure.name='TaskOutputPersistenceError';",
      ' throw failure;',
      '};',
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const args=[
      '--import',pathToFileURL(preloader).href,cli,'--print','--provider','deepseek',
      '--cwd',root,'--session-id',sessionId,
      '--max-turns','4','--max-retries','0','--compact-threshold','0',
      '--allowedTools','Bash('+command+')',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Start and stop the background task safely',
    ];
    child=spawn(process.execPath,args,{
      env:{...process.env,DEEPSEEK_API_KEY:'test-only-local'},
      stdio:['ignore','pipe','pipe'],windowsHide:true,
    });
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>{stdout+=x;});
    child.stderr.on('data',x=>{stderr+=x;});
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),28000);
    const result=await closed;
    assert.equal(result.signal,null,stderr);
    assert.equal(result.code,1,stdout+stderr);
    assert.equal(requests.length,2,
      'native TaskStop finalization error must block the third provider call');
    assert.ok(backgroundId,'original Bash background task must execute first');
    assert.match(stderr,/TaskOutputPersistenceError|INJECTED_NATIVE_TASK_OUTPUT_IO_FAILURE|Bash TaskOutput persistence failed/);
    assert.doesNotMatch(stdout,/ERROR_WAS_WRONGLY_REPORTED_AS_SUCCESS/);
    const sessionPath=join(root,'.agent-cil','sessions',sessionId,'transcript.jsonl');
    const records=(await readFile(sessionPath,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(x=>x.kind==='tool').length,1,
      'only the successfully started background Bash can be committed');
    assert.ok(records.some(x=>x.kind==='tool_started'));
    assert.equal(records.at(-1).kind,'tool_started',
      'TaskStop failure must retain the executing witness, not fake a result');
    const before=await optional(join(root,'real-background-heartbeat.txt'));
    await new Promise(resolve=>setTimeout(resolve,430));
    assert.equal(await optional(join(root,'real-background-heartbeat.txt')),before,
      'real background process must be stopped even after output read fails');
    const session=await openSessionJournal({workspace:root,sessionId,resume:true});
    try{
      assert.equal(session.needsToolReconciliation,true);
    }finally{await session.close();}
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child?.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
