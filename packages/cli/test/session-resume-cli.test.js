import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
function frame(type,data={}){
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
}
function writeToolStream(){
  return frame('message_start',{message:{usage:{input_tokens:37}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id:'session-write-once',name:'Write',input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({
        file_path:'saved.txt',content:'must persist exactly once',
      }),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:19}})+
    frame('message_stop');
}
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:60}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'Resumed without another Write.'}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:11}})+
    frame('message_stop');
}
async function childProcess(argv, env, timeout=18000, stdinText) {
  const child=spawn(process.execPath,[cli,...argv],{
    env:{...process.env, ...env},
    stdio:[stdinText===undefined?'ignore':'pipe','pipe','pipe'],
  });
  if(stdinText!==undefined)child.stdin.end(stdinText);
  const stdout=[],stderr=[];
  child.stdout.on('data',c=>stdout.push(c));
  child.stderr.on('data',c=>stderr.push(c));
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  try {
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve([code,signal]));
    });
    return {code,signal,stdout:Buffer.concat(stdout).toString('utf8'),
      stderr:Buffer.concat(stderr).toString('utf8')};
  }finally{clearTimeout(timer);if(child.exitCode===null && !child.killed)child.kill('SIGKILL');}
}

test('real installed CLI: --resume with no new prompt continues pending tool result, then finished session refuses empty replay', {
  timeout:65000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-live-session-'));
  const id=randomUUID();
  let mode='first',requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({mode,body});
    if(mode==='first'&&requests.filter(x=>x.mode==='first').length===1){
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(writeToolStream());
    }else if(mode==='first'){
      // Deliberate failure AFTER Write's successful tool_result has been
      // checkpointed: the first process exits without a final answer.
      res.writeHead(503,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'intentional post-tool network outage'}}));
    }else{
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(finalStream());
    }
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const baseUrl='http://127.0.0.1:'+server.address().port+'/anthropic';
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-turns','3','--max-retries','0','--compact-threshold','0',
      '--base-url',baseUrl];
    const env={DEEPSEEK_API_KEY:'mock-session-token'};
    const first=await childProcess([
      ...flags,'--session-id',id,'--allow-edits','Write saved.txt exactly once.',
    ],env);
    assert.equal(first.signal,null,first.stderr);
    assert.equal(first.code,1,first.stdout+first.stderr);
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),'must persist exactly once');
    assert.equal(requests.filter(x=>x.mode==='first').length,2);
    assert.match(first.stderr,new RegExp(id));
    const journal=await readFile(join(root,'.agent-cil','sessions',id,'transcript.jsonl'),'utf8');
    const records=journal.trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(records.length>=1);
    assert.equal(records[0].kind,'input','the source persists the first user message before model streaming');
    assert.equal(records[0].type,'session_commit');
    assert.equal(records[0].version,2);
    assert.equal(records[0].entries.length,1);
    assert.equal(records[0].entries[0].parentUuid,null);
    const pendingRecord=records.find(record=>record.kind==='tool_pending');
    assert.ok(pendingRecord,'original assistant tool_use is committed before execution');
    assert.equal(pendingRecord.entries.length,1);
    assert.equal(pendingRecord.entries[0].parentUuid,records[0].leafUuid);
    assert.equal(pendingRecord.entries[0].message.content[0].id,'session-write-once');
    const toolRecord=records.find(record=>record.kind==='tool');
    assert.ok(toolRecord,'completed tool batch still gets its own fsynced checkpoint');
    assert.equal(toolRecord.entries.length,1);
    assert.equal(toolRecord.entries[0].sourceToolAssistantUUID,pendingRecord.leafUuid);
    assert.equal(toolRecord.entries[0].parentUuid,pendingRecord.leafUuid);
    assert.equal(toolRecord.entries[0].message.content[0].tool_use_id,'session-write-once');
    assert.equal(toolRecord.entries[0].message.content[0].is_error,undefined);

    mode='resume';
    const second=await childProcess([
      ...flags,'--resume',id,
    ],env);
    assert.equal(second.signal,null,second.stderr);
    assert.equal(second.code,0,second.stdout+second.stderr);
    assert.match(second.stdout,/Resumed without another Write/);
    assert.equal(requests.filter(x=>x.mode==='resume').length,1,
      'resumed CLI must not call model to rerun previously committed tool');
    const resumed=requests.find(x=>x.mode==='resume').body.messages;
    const stored=records.flatMap(record=>record.entries.map(entry=>entry.message));
    // The Anthropic adapter intentionally strips internal stop_reason and
    // usage from the outgoing API projection; the persisted journal retains
    // them. Verify every original message's identity and API-visible content.
    assert.deepEqual(
      resumed.slice(0,stored.length).map(({role,content})=>({role,content})),
      stored.map(({role,content})=>({role,content})),
      'resumed provider request receives the exact model-visible committed transcript',
    );
    assert.equal(stored[1].stop_reason,'tool_use');
    assert.equal(stored[1].usage.input_tokens,37);
    assert.equal(resumed.length,stored.length,
      'promptless resume must not create a synthetic user message');
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),'must persist exactly once');
    const latest=(await readFile(join(root,'.agent-cil','sessions',id,'transcript.jsonl'),'utf8'))
      .trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(latest.kind,'finished');
    assert.equal(latest.entries.length,1,'final result appends one UUID-linked message');
    assert.equal(latest.entries[0].parentUuid,toolRecord.leafUuid);
    assert.match(latest.entries.at(-1).message.content[0].text,/Resumed without another Write/);
    // A final assistant answer is already committed. Trying another
    // promptless resume must fail without even issuing an API request.
    const requestsBefore= requests.length;
    const third=await childProcess([...flags,'--resume',id],env);
    assert.equal(third.code,2,third.stderr);
    assert.match(third.stderr,/no committed pending user prompt or tool result/i);
    assert.equal(requests.length,requestsBefore);
    // A finished session must still accept an explicit new user prompt from
    // stdin. Omitting a positional prompt is NOT equivalent to empty stdin.
    const piped='A new user prompt supplied through a pipe';
    const fourth=await childProcess([...flags,'--resume',id],env,18000,piped);
    assert.equal(fourth.code,0,fourth.stdout+fourth.stderr);
    assert.equal(requests.filter(x=>x.mode==='resume').length,2);
    const latestRequest=requests.at(-1).body.messages;
    assert.equal(latestRequest.at(-1).role,'user');
    assert.equal(latestRequest.at(-1).content,piped);
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),
      'must persist exactly once');
    assert.equal(first.stderr.includes('mock-session-token'),false);
    assert.equal(second.stderr.includes('mock-session-token'),false);
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

test('real CLI resumes an unanswered persisted user prompt after first provider request fails', {
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-unanswered-'));
  const id=randomUUID();
  let mode='unavailable';
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests.push({mode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
    if(mode==='unavailable'){
      res.writeHead(503,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'provider unavailable before SSE'}}));
    }else{
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(finalStream());
    }
  });
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const env={DEEPSEEK_API_KEY:'mock-unanswered-token'};
    const prompt='Preserve this exact initial user input even on HTTP 503';
    const first=await childProcess([...flags,'--session-id',id,prompt],env);
    assert.equal(first.code,1,first.stdout+first.stderr);
    assert.equal(requests.length,1);
    const file=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const entries=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.length,1,'no fabricated assistant completion or lost user prompt');
    assert.equal(entries[0].kind,'input');
    assert.equal(entries[0].entries.length,1);
    assert.deepEqual(entries[0].entries[0].message,{role:'user',content:prompt});
    assert.equal(entries[0].entries[0].parentUuid,null);
    mode='available';
    const resumed=await childProcess([...flags,'--resume',id],env);
    assert.equal(resumed.code,0,resumed.stdout+resumed.stderr);
    assert.match(resumed.stdout,/Resumed without another Write/);
    assert.equal(requests.length,2);
    assert.deepEqual(requests[1].body.messages,[{role:'user',content:prompt}],
      'resumed request uses the saved input without a synthetic duplicate');
    const history=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(history.map(x=>x.kind),['input','finished']);
    assert.equal(history[1].entries[0].parentUuid,history[0].leafUuid);
    const repeated=await childProcess([...flags,'--resume',id],env);
    assert.equal(repeated.code,2,repeated.stdout+repeated.stderr);
    assert.equal(requests.length,2,'final answer cannot be silently regenerated');
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});


test('real CLI fences replaced transcript after Write and does not issue a follow-up model request', {
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-transcript-fence-'));
  const id=randomUUID();
  const log=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
  let requests=0;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests++;
    // The CLI has already fsynced its first user input. Replace its live
    // transcript with a distinct inode of the same length while preserving
    // the owner lock, then make the model request a side-effecting Write.
    // Without a store fence, its later tool-result commit silently extends
    // a foreign file and a second model request can run on corrupted state.
    const original=await readFile(log,'utf8');
    await rename(log,log+'.displaced');
    await writeFile(log,original);
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(writeToolStream());
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-turns','3','--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const env={DEEPSEEK_API_KEY:'mock-fence-token'};
    const result=await childProcess([
      ...flags,'--session-id',id,'--allow-edits','Write saved.txt once.',
    ],env);
    assert.equal(result.code,1,result.stdout+result.stderr);
    assert.match(result.stderr,/transcript was externally replaced or modified; writes fenced/);
    assert.equal(requests,1,'a failed tool-result commit must not reach the second model request');
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),
      'must persist exactly once','tool can have acted before a rejected durable checkpoint');
    const records=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input'],
      'the substituted transcript must not acquire an untrusted tool_result');
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});


test('real CLI SIGKILL after Write side effect retains assistant tool_use and refuses unsafe replay', {
  timeout:65000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-pending-crash-'));
  const id=randomUUID();
  let requests=0;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(writeToolStream());
  });
  let child,guard;
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    // A genuine original PostToolUse command hook delays tool_result
    // completion after Write has created the file. Kill the main CLI while
    // the post-hook is in flight, not during an untrusted partial SSE.
    await writeFile(join(root,'delayed-posthook.cjs'),
      "process.stdin.resume();process.stdin.on('end',()=>{"+
      "require('node:fs').writeFileSync('hook-entered.txt','entered');"+
      "const parent=process.ppid;const timer=setInterval(()=>{"+
      "try{process.kill(parent,0);}catch{clearInterval(timer);process.exit(0);}},60);"+
      "setTimeout(()=>process.exit(0),6500);});");
    await writeFile(join(root,'hooks.json'),JSON.stringify({hooks:{
      PostToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node delayed-posthook.cjs',timeout:12,
      }]}],
    }}));
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--compact-threshold','0','--max-turns','3',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const env={...process.env,DEEPSEEK_API_KEY:'mock-pending-token'};
    child=spawn(process.execPath,[cli,...flags,'--hooks-file',
      join(root,'hooks.json'),'--allow-edits','--session-id',id,
      'Write saved.txt once.'],{env,stdio:['ignore','pipe','pipe']});
    const stderr=[];
    child.stderr.on('data',x=>stderr.push(x));
    child.stdout.on('data',()=>{});
    const closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    guard=setTimeout(()=>child.kill('SIGKILL'),16000);
    let hookEntered=false;
    for(let attempt=0;attempt<250;attempt++){
      try{
        hookEntered=(await readFile(join(root,'hook-entered.txt'),'utf8'))==='entered';
        if(hookEntered)break;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.equal(hookEntered,true,Buffer.concat(stderr).toString('utf8'));
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),'must persist exactly once');
    child.kill('SIGKILL');
    await closed;
    clearTimeout(guard);
    const journal=(await readFile(join(root,'.agent-cil','sessions',id,'transcript.jsonl'),'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(journal.map(x=>x.kind),['input','tool_pending'],
      'complete assistant tool_use must survive interruption before tool_result');
    assert.equal(journal[1].entries[0].parentUuid,journal[0].leafUuid);
    assert.equal(journal[1].entries[0].message.content[0].id,'session-write-once');
    const before=requests;
    const empty=await childProcess([...flags,'--resume',id],env);
    assert.equal(empty.code,2,empty.stdout+empty.stderr);
    assert.match(empty.stderr,/unfinished tool batch|automatic replay is unsafe/i);
    const withPrompt=await childProcess([...flags,'--resume',id,'try again'],env);
    assert.equal(withPrompt.code,2,withPrompt.stdout+withPrompt.stderr);
    assert.match(withPrompt.stderr,/unfinished tool batch/i);
    assert.equal(requests,before,'a resumed process must never regenerate the tool_use');
    assert.equal(await readFile(join(root,'saved.txt'),'utf8'),'must persist exactly once');
  }finally{
    if(guard)clearTimeout(guard);
    if(child&&child.exitCode===null&&!child.killed)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});

test('CLI validates session arguments without network access',()=>{
  const id=randomUUID();
  assert.equal(parseArgs(['--session-id',id,'run']).sessionId,id);
  assert.equal(parseArgs(['--resume='+id,'run']).resume,id);
  assert.throws(()=>parseArgs(['--session-id','../elsewhere']),/valid UUID/);
  assert.throws(()=>parseArgs(['--resume',id,'--session-id',randomUUID()]),
    /cannot be used together/);
});
