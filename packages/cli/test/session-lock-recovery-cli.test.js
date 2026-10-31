import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {openSessionJournal} from '../../runtime/src/legacy-session/session-storage.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+
  '\ndata: '+JSON.stringify({type,...data})+'\n\n';
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:8}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'text',text:'',
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'EXCLUSIVE_RESUME_FINISHED',
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},
      usage:{output_tokens:5}})+frame('message_stop');
}
function childCli(args){
  const child=spawn(process.execPath,[cli,...args],{
    env:{...process.env,DEEPSEEK_API_KEY:'local-lock-race-only'},
    stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  let out='',err='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',x=>{out+=x;});
  child.stderr.on('data',x=>{err+=x;});
  const finished=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({
      code,signal,stdout:out,stderr:err,
    }));
  });
  return {child,finished};
}

test('two installed CLIs racing to resume a crashed session must send only one model request',{
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-packed-lock-race-'));
  const id=randomUUID();
  const children=[];
  let journal;
  let release;
  let requestArrived;
  const gate=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{requestArrived=resolve;});
  const requests=[];
  const server=createServer(async(req,res)=>{
    const body=[];for await(const data of req)body.push(data);
    requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
    requestArrived();
    await gate;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  const deadline=(ms)=>new Promise((_,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Concurrent CLI lock test timed out')),ms);
    timeout.unref?.();
  });
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    const originalPrompt='Finish a saved but unanswered user request exactly once.';
    await journal.append({
      messages:[{role:'user',content:originalPrompt}],kind:'input',
    });
    const path=journal.path;
    await journal.close();journal=null;
    const original=await readFile(path,'utf8');
    // Use a PID from a truly exited subprocess, never an invented live PID.
    const dead=spawn(process.execPath,['-e','process.exit(0)'],{
      stdio:'ignore',windowsHide:true,
    });
    const stalePid=dead.pid;
    const [deadCode]=await new Promise((resolve,reject)=>{
      dead.once('error',reject);
      dead.once('close',(code,sig)=>resolve([code,sig]));
    });
    assert.equal(deadCode,0);
    await writeFile(path+'.lock',JSON.stringify({
      pid:stalePid,startedAt:0,token:randomUUID(),
    })+'\n');
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const args=['--print','--provider','deepseek',
      '--cwd',root,'--resume',id,
      '--max-turns','2','--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
    ];
    children.push(childCli(args),childCli(args));
    // Keep the winning owner in the in-flight SSE request. Another
    // process MUST reject while that same real CLI owns the journal.
    await Promise.race([entered,deadline(15000)]);
    const closed=children.map((x,i)=>x.finished.then(result=>({i,...result})));
    const firstExit=await Promise.race([...closed,deadline(15000)]);
    assert.equal(firstExit.signal,null,firstExit.stderr);
    assert.equal(firstExit.code,2,JSON.stringify(firstExit));
    assert.match(firstExit.stderr,/already active|recovering this session lock/);
    assert.equal(requests.length,1,
      'second competing CLI must never invoke provider while first owns session');
    release();
    const results=await Promise.all(closed);
    assert.deepEqual(results.map(x=>x.code).sort((a,b)=>a-b),[0,2],
      JSON.stringify(results));
    assert.equal(requests.length,1);
    assert.deepEqual(requests[0].messages,[
      {role:'user',content:originalPrompt},
    ]);
    assert.equal(results.filter(x=>x.code===0).length,1);
    assert.match(results.find(x=>x.code===0).stdout,/EXCLUSIVE_RESUME_FINISHED/);
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input','finished']);
    assert.ok((await readFile(path,'utf8')).startsWith(original),
      'the original user checkpoint must remain byte-identical');
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'});
    await assert.rejects(stat(path+'.lock.reclaim'),{code:'ENOENT'});
  }finally{
    release();
    for(const {child} of children)if(child.exitCode===null)child.kill('SIGKILL');
    if(journal)await journal.close().catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:100});
  }
});
