import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSessionJournal} from '../../runtime/src/legacy-session/session-storage.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
function frame(type,more={}) {
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...more})+'\n\n';
}
function bashStream(command) {
  return frame('message_start',{message:{usage:{input_tokens:20}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id:'real-sigterm-bash',name:'Bash',input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({
        command,timeout_ms:25000,
      }),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:15}})+
    frame('message_stop');
}
async function maybeRead(path) {
  try{return await readFile(path,'utf8');}
  catch(error){if(error.code==='ENOENT')return '';throw error;}
}
async function runCli(args,env) {
  const child=spawn(process.execPath,[cli,...args],{
    env:{...process.env,...env},stdio:['ignore','pipe','pipe'],
  });
  const err=[],out=[];
  child.stderr.on('data',b=>err.push(b));
  child.stdout.on('data',b=>out.push(b));
  const timeout=setTimeout(()=>child.kill('SIGKILL'),13000);
  try {
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(c,s)=>resolve([c,s]));
    });
    return {code,signal,stderr:Buffer.concat(err).toString('utf8'),
      stdout:Buffer.concat(out).toString('utf8')};
  }finally{clearTimeout(timeout);}
}

test('real CLI SIGTERM kills a detached Bash grandchild outside the shell process group and safely fences resume', {
  skip:process.platform==='win32' &&
    'Windows does not deliver catchable POSIX SIGTERM to Node; Windows Bash cancellation uses AbortSignal tests',
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-sigterm-bash-'));
  const id=randomUUID(),command='node long-running.cjs',env={DEEPSEEK_API_KEY:'local-test-token'};
  const server=createServer(async(req,res)=>{
    for await(const part of req)void part;
    requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(bashStream(command));
  });
  let requests=0,child,watchdog,closed;
  const heartbeat=join(root,'grandchild-heartbeat.txt');
  const grandchildPid=join(root,'grandchild-pid.txt');
  try {
    await writeFile(join(root,'long-running.cjs'),
      "const fs=require('node:fs');"+
      "const {spawn}=require('node:child_process');"+
      "const leaf=spawn(process.execPath,['-e',"+
      "\"const fs=require('node:fs');setInterval(()=>fs.appendFileSync('grandchild-heartbeat.txt','x'),35)\""+
      "],{cwd:process.cwd(),detached:true,stdio:'ignore'});"+
      "fs.writeFileSync('grandchild-pid.txt',String(leaf.pid));"+
      "setInterval(()=>{},500);");
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--compact-threshold','0','--max-turns','3',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      '--allowedTools','Bash('+command+')'];
    child=spawn(process.execPath,[cli,...flags,'--session-id',id,
      'Run the authorized Bash command'],{
      env:{...process.env,...env},stdio:['ignore','pipe','pipe'],
    });
    const err=[];
    child.stderr.on('data',b=>err.push(b));child.stdout.resume();
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),19000);
    let started=false;
    for(let i=0;i<310;i++){
      const beat=await maybeRead(heartbeat);
      if(beat.length>=3){started=true;break;}
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.equal(started,true,Buffer.concat(err).toString('utf8'));
    assert.equal(requests,1);
    assert.equal(child.kill('SIGTERM'),true);
    const exit=await closed;
    assert.equal(exit.signal,null,Buffer.concat(err).toString('utf8'));
    assert.equal(exit.code,143,Buffer.concat(err).toString('utf8'));
    // Detached:true creates a distinct POSIX session: the old group-only
    // kill misses it, but 2.1.304 descendant-PID enumeration must not.
    const checkpoint=await maybeRead(heartbeat);
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(await maybeRead(heartbeat),checkpoint,
      'CLI SIGTERM must reap Bash grandchildren before its process exits');
    const journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.messages.map(m=>m.role),['user','assistant']);
    assert.deepEqual(journal.startedToolExecutions.map(x=>x.toolUseId),
      ['real-sigterm-bash']);
    assert.deepEqual(journal.mappedToolResults,[]);
    assert.equal(journal.needsToolReconciliation,true);
    const records=(await readFile(journal.path,'utf8')).trim()
      .split('\n').map(JSON.parse);
    assert.deepEqual(records.map(r=>r.kind),
      ['input','tool_pending','tool_started']);
    await journal.close();
    const blocked=await runCli([...flags,'--resume',id],env);
    assert.equal(blocked.code,2,blocked.stdout+blocked.stderr);
    assert.match(blocked.stderr,/unfinished tool batch|automatic replay is unsafe/i);
    assert.equal(requests,1,'no provider replay after an interrupted Bash');
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child && child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    const pid=Number(await maybeRead(grandchildPid));
    if(Number.isSafeInteger(pid)&&pid>0){
      try{process.kill(pid,'SIGKILL');}catch{}
    }
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:160});
  }
});
