import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openSessionJournal} from '../../runtime/src/legacy-session/session-storage.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,body={})=>
  'event: '+type+'\ndata: '+JSON.stringify({type,...body})+'\n\n';
const tool=(id,name,input)=>
  frame('message_start',{message:{usage:{input_tokens:32}}})+
  frame('content_block_start',{index:0,content_block:{type:'tool_use',
    id,name,input:{}}})+
  frame('content_block_delta',{index:0,delta:{type:'input_json_delta',
    partial_json:JSON.stringify(input)}})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:9}})+
  frame('message_stop');
const final=()=>
  frame('message_start',{message:{usage:{input_tokens:20}}})+
  frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
  frame('content_block_delta',{index:0,delta:{type:'text_delta',
    text:'THIS_RESULT_MUST_NOT_BE_REACHED'}})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'end_turn'}})+frame('message_stop');

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForFile(path) {
  for(let i=0;i<260;i++){
    try{await stat(path);return;}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await delay(25);
  }
  throw new Error('Actual background Bash did not reach exit before SSE Write.');
}

test('installed CLI rejects a streamed Write after background Bash TaskOutput became fatally untrustworthy mid-SSE',{
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-background-midstream-'));
  const sessionId=randomUUID();
  const command='node bash-early-exit.cjs';
  const indicator=join(root,'bash-finished.txt');
  const forbidden=join(root,'must-not-write.txt');
  const requests=[];
  let child,closed,watchdog;
  const server=createServer(async(req,res)=>{
    const body=[];
    for await(const part of req)body.push(part);
    requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
    if(requests.length===1) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(tool('launch-original-background','Bash',{
        command,run_in_background:true,timeout_ms:15000,
      }));
    } else if(requests.length===2) {
      // This request STARTS before the background process has completed.
      // Its tool stream arrives only AFTER the actual OS process exits
      // and the native TaskOutput read has rejected in the CLI worker.
      await waitForFile(indicator);
      await delay(850);
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(tool('unsafe-followup-write','Write',{
        file_path:'must-not-write.txt',content:'DANGEROUS_UNFENCED_WRITE',
      }));
    } else {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(final());
    }
  });
  try{
    await writeFile(join(root,'bash-early-exit.cjs'),[
      "const fs=require('node:fs');",
      "process.stdout.write('REAL_BACKGROUND_STARTED\\n');",
      "setTimeout(()=>{",
      " fs.writeFileSync('bash-finished.txt','original Bash really exited');",
      " process.exit(0);",
      "},850);",
    ].join('\n'));
    const realIndex=await realpath(cli);
    const taskOutputModule=pathToFileURL(join(dirname(realIndex),
      'legacy-task-output.js')).href;
    const preloader=join(root,'inject-native-fatal-output.mjs');
    await writeFile(preloader,[
      'const {TaskOutput}=await import('+JSON.stringify(taskOutputModule)+');',
      'TaskOutput.prototype.getStdout=async function(){',
      " const failure=new Error('BACKGROUND_NATIVE_OUTPUT_REPLACED');",
      " failure.name='TaskOutputPersistenceError';",
      ' throw failure;',
      '};',
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[
      // Node's Windows ESM loader treats C:\\... as an unsupported URL
      // scheme for --import; use the same file:// identity as the installed
      // TaskOutput module instead of a platform-specific path.
      '--import',pathToFileURL(preloader).href,cli,'--print','--provider','deepseek',
      '--cwd',root,'--session-id',sessionId,
      '--max-turns','4','--max-retries','0','--compact-threshold','0',
      '--allowedTools','Bash('+command+')','--allow-edits',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Launch background Bash then follow the authorized tool instructions.',
    ],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-background-midstream-only'},
      stdio:['ignore','pipe','pipe'],windowsHide:true,
    });
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>{stdout+=x;});
    child.stderr.on('data',x=>{stderr+=x;});
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),33000);
    const outcome=await closed;
    assert.equal(outcome.signal,null,stderr);
    assert.equal(outcome.code,1,stdout+stderr);
    assert.equal(requests.length,2,
      'only Bash launch and the already-in-flight SSE turn may reach provider; '+
      JSON.stringify({stderr,stdout,exit:outcome}));
    assert.match(await readFile(indicator,'utf8'),/really exited/);
    await assert.rejects(stat(forbidden),{code:'ENOENT'},
      'the next streamed tool cannot mutate the workspace after lost Bash output');
    assert.match(stderr,/BACKGROUND_NATIVE_OUTPUT_REPLACED|TaskOutputPersistenceError/);
    assert.doesNotMatch(stdout,/THIS_RESULT_MUST_NOT_BE_REACHED/);
    const file=join(root,'.agent-cil','sessions',sessionId,'transcript.jsonl');
    const entries=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(x=>x.kind==='tool_started'&&
      x.toolName==='Bash'));
    assert.ok(entries.some(x=>x.kind==='tool'&&
      JSON.stringify(x.entries).includes('launch-original-background')));
    assert.ok(entries.some(x=>x.kind==='tool_pending'&&
      JSON.stringify(x.entries).includes('unsafe-followup-write')));
    assert.ok(!entries.some(x=>x.kind==='tool_started'&&
      x.toolName==='Write'),
      'the fatal owner check must reject before Write begins execution');
    const session=await openSessionJournal({workspace:root,sessionId,resume:true});
    try{assert.equal(session.needsToolReconciliation,true);}
    finally{await session.close();}
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:120});
  }
});
