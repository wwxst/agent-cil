import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile, rename, appendFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/index.js';
import { openSessionJournal } from '../../runtime/src/legacy-session/session-storage.js';

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
    // Execution/mapped witnesses are durable evidence, not model messages.
    const stored=records.flatMap(record=>
      Array.isArray(record.entries)?record.entries.map(entry=>entry.message):[]);
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


test('real CLI fences replaced transcript before executing Write and blocks the follow-up model request', {
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
    await assert.rejects(readFile(join(root,'saved.txt'),'utf8'),{code:'ENOENT'},
      'pending tool_use must be durably recorded before a Write side effect');
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
      "const fs=require('node:fs');"+
      "fs.writeFileSync('hook-entered.txt','entered');"+
      "process.on('exit',()=>fs.writeFileSync('hook-exited.txt','exited'));"+
      "const timer=setInterval(()=>{if(fs.existsSync('release-hook.txt')){"+
      "clearInterval(timer);process.exit(0);}},40);"+
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
    // On Windows the PostToolUse child may keep its working directory
    // opened after the CLI is killed. Release it explicitly before cleanup.
    await writeFile(join(root,'release-hook.txt'),'release');
    let hookExited=false;
    for(let attempt=0;attempt<250;attempt++){
      try{
        hookExited=(await readFile(join(root,'hook-exited.txt'),'utf8'))==='exited';
        if(hookExited)break;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.equal(hookExited,true,'post-hook child must release its cwd on Windows');
    const journal=(await readFile(join(root,'.agent-cil','sessions',id,'transcript.jsonl'),'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(journal.map(x=>x.kind),['input','tool_pending','tool_started','tool_mapped'],
      'authorized Write start and mapped result survive PostToolUse interruption');
    assert.equal(journal[1].entries[0].parentUuid,journal[0].leafUuid);
    assert.equal(journal[1].entries[0].message.content[0].id,'session-write-once');
    assert.equal(journal[2].assistantUuid,journal[1].leafUuid);
    assert.equal(journal[2].status,'executing');
    assert.equal(journal[2].toolUseId,'session-write-once');
    assert.equal(journal[2].toolName,'Write');
    assert.equal(journal[3].assistantUuid,journal[1].leafUuid);
    assert.equal(journal[3].leafUuid,journal[1].leafUuid,
      'pre-Hook evidence must not advance the assistant/result ancestry');
    assert.equal(journal[3].mappedResult.tool_use_id,'session-write-once');
    assert.equal(journal[3].mappedResult.type,'tool_result');
    assert.equal(journal[3].mappedResult.is_error,undefined);
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
    // Also release the hook after an assertion failure.
    await writeFile(join(root,'release-hook.txt'),'release').catch(()=>{});
    for(let attempt=0;attempt<170;attempt++){
      try{
        if((await readFile(join(root,'hook-exited.txt'),'utf8'))==='exited')break;
      }catch(error){if(error.code!=='ENOENT')break;}
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
});


test('real CLI --resume sends both recovered source sibling tool results to the next provider request', {
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-sibling-resume-'));
  const id=randomUUID();
  const incoming=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    incoming.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Read both independent files'}];
    const pending=[...input,{role:'assistant',id:'parallel-source-message',content:[
      {type:'tool_use',id:'source-read-1',name:'Read',input:{file_path:'one.txt'}},
      {type:'tool_use',id:'source-read-2',name:'Read',input:{file_path:'two.txt'}},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    const file=journal.path;
    await journal.close();
    const existing=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    const prior=existing.at(-1);
    const sourceUUID=prior.leafUuid;
    const entry=(idValue,name)=>({
      type:'user',uuid:randomUUID(),parentUuid:sourceUUID,
      sourceToolAssistantUUID:sourceUUID,sessionId:id,
      message:{role:'user',content:[{
        type:'tool_result',tool_use_id:idValue,content:name,
      }]},
    });
    const first=entry('source-read-1','result one');
    const second=entry('source-read-2','result two');
    const payload={
      type:'session_commit',version:2,sessionId:id,
      workspace:await realpath(root),kind:'tool',
      sequence:prior.sequence+1,previousHash:prior.hash,
      root:false,leafUuid:second.uuid,entries:[first,second],
    };
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await appendFile(file,JSON.stringify({...payload,hash})+'\n');
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--max-turns','3','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const cliRun=await childProcess([...flags,'--resume',id],
      {DEEPSEEK_API_KEY:'mock-parallel-session-token'});
    assert.equal(cliRun.code,0,cliRun.stdout+cliRun.stderr);
    assert.equal(incoming.length,1,'original completed tool uses must not be re-executed');
    const resultIDs=incoming[0].messages
      .filter(m=>m.role==='user')
      .flatMap(m=>Array.isArray(m.content)?m.content:[])
      .filter(b=>b.type==='tool_result')
      .map(b=>b.tool_use_id);
    assert.deepEqual(resultIDs,['source-read-1','source-read-2'],
      'both source DAG siblings must reach the real provider transport');
    const committed=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(committed.at(-1).kind,'finished');
    assert.equal(committed.at(-1).entries[0].parentUuid,second.uuid);
    assert.match(cliRun.stdout,/Resumed without another Write/);
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});


function twoWriteToolStream() {
  let output=frame('message_start',{message:{usage:{input_tokens:42}}});
  for(const [index,id,file] of [
    [0,'parallel-write-one','first.txt'],
    [1,'parallel-write-two','second.txt'],
  ]) {
    output+=frame('content_block_start',{index,content_block:{
      type:'tool_use',id,name:'Write',input:{},
    }});
    output+=frame('content_block_delta',{index,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({
        file_path:file,content:'content '+id,
      }),
    }});
    output+=frame('content_block_stop',{index});
  }
  return output+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:30}})+
    frame('message_stop');
}

test('real CLI SIGKILL after first of two Writes keeps first individual tool_result and blocks duplicate resume', {
  timeout:70000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-partial-siblings-'));
  const id=randomUUID();
  let providerRequests=0;
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(chunk);
    providerRequests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(twoWriteToolStream());
  });
  let child,watchdog;
  try{
    await writeFile(join(root,'second-posthook.cjs'),
      "const fs=require('node:fs');let body='';"+
      "process.stdin.on('data',x=>body+=x);process.stdin.on('end',()=>{"+
      "const data=JSON.parse(body);"+
      "if(data.tool_use_id!=='parallel-write-two')process.exit(0);"+
      "fs.writeFileSync('second-hook-entered.txt','entered');"+
      "process.on('exit',()=>fs.writeFileSync('second-hook-exited.txt','exited'));"+
      "const t=setInterval(()=>{if(fs.existsSync('release-second-hook.txt')){"+
      "clearInterval(t);process.exit(0);}},35);"+
      "setTimeout(()=>process.exit(0),6500);});");
    await writeFile(join(root,'hooks.json'),JSON.stringify({hooks:{
      PostToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node second-posthook.cjs',timeout:12,
      }]}],
    }}));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--compact-threshold','0','--max-turns','3',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const env={...process.env,DEEPSEEK_API_KEY:'mock-partial-token'};
    child=spawn(process.execPath,[cli,...flags,'--hooks-file',
      join(root,'hooks.json'),'--allow-edits','--session-id',id,
      'Write both files in model order.'],{env,stdio:['ignore','pipe','pipe']});
    const errs=[];child.stderr.on('data',x=>errs.push(x));
    child.stdout.on('data',()=>{});
    const closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve([code,signal]));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),18000);
    let entered=false;
    for(let i=0;i<290;i++){
      try {
        entered=(await readFile(join(root,'second-hook-entered.txt'),'utf8'))==='entered';
        if(entered)break;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    assert.equal(entered,true,Buffer.concat(errs).toString('utf8'));
    assert.equal(await readFile(join(root,'first.txt'),'utf8'),
      'content parallel-write-one');
    assert.equal(await readFile(join(root,'second.txt'),'utf8'),
      'content parallel-write-two');
    child.kill('SIGKILL');
    await closed;
    clearTimeout(watchdog);
    await writeFile(join(root,'release-second-hook.txt'),'yes');
    let exited=false;
    for(let i=0;i<290;i++){
      try {
        exited=(await readFile(join(root,'second-hook-exited.txt'),'utf8'))==='exited';
        if(exited)break;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    assert.equal(exited,true,'hook subprocess must release Windows cwd');
    const file=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const records=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),
      ['input','tool_pending','tool_started','tool_mapped','tool_partial',
       'tool_started','tool_mapped']);
    assert.equal(records[2].toolUseId,'parallel-write-one');
    assert.equal(records[3].mappedResult.tool_use_id,'parallel-write-one');
    assert.equal(records[5].toolUseId,'parallel-write-two');
    assert.equal(records[6].mappedResult.tool_use_id,'parallel-write-two');
    assert.equal(records[4].entries.length,1);
    assert.equal(records[4].entries[0].parentUuid,records[1].leafUuid);
    assert.equal(records[4].entries[0].sourceToolAssistantUUID,records[1].leafUuid);
    assert.equal(records[4].entries[0].message.content[0].tool_use_id,'parallel-write-one');
    const before=providerRequests;
    const noPrompt=await childProcess([...flags,'--resume',id],env);
    const withPrompt=await childProcess([...flags,'--resume',id,'retry'],env);
    assert.equal(noPrompt.code,2,noPrompt.stdout+noPrompt.stderr);
    assert.equal(withPrompt.code,2,withPrompt.stdout+withPrompt.stderr);
    assert.match(noPrompt.stderr,/unfinished tool batch|automatic replay is unsafe/i);
    assert.equal(providerRequests,before,'must not regenerate or replay either Write');
    assert.equal(await readFile(join(root,'first.txt'),'utf8'),'content parallel-write-one');
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null&&!child.killed)child.kill('SIGKILL');
    await writeFile(join(root,'release-second-hook.txt'),'yes').catch(()=>{});
    for(let i=0;i<190;i++){
      try{
        if((await readFile(join(root,'second-hook-exited.txt'),'utf8'))==='exited')break;
      }catch(error){if(error.code!=='ENOENT')break;}
      await new Promise(resolve=>setTimeout(resolve,35));
    }
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
});


test('real CLI refuses checksum-valid out-of-order partial results before any model request', {
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-partial-order-'));
  const id=randomUUID();
  let requests=0;
  const server=createServer(async(req,res)=>{
    for await(const chunk of req)void chunk;
    requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Run two Writes'}];
    const pending=[...input,{role:'assistant',content:[
      {type:'tool_use',id:'first',name:'Write',
        input:{file_path:'one',content:'first'}},
      {type:'tool_use',id:'second',name:'Write',
        input:{file_path:'two',content:'second'}},
    ]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    const file=journal.path;
    await journal.close();
    const existing=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    const previous=existing.at(-1),source=previous.leafUuid;
    const result={type:'user',uuid:randomUUID(),parentUuid:source,
      sourceToolAssistantUUID:source,sessionId:id,
      message:{role:'user',content:[{
        type:'tool_result',tool_use_id:'second',content:'unauthorized skipped predecessor',
      }]}};
    const payload={type:'session_commit',version:2,sessionId:id,
      workspace:await realpath(root),kind:'tool_partial',
      sequence:previous.sequence+1,previousHash:previous.hash,
      root:false,leafUuid:result.uuid,entries:[result]};
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await appendFile(file,JSON.stringify({...payload,hash})+'\n');
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const env={DEEPSEEK_API_KEY:'mock-ordered-result-token'};
    const run=await childProcess([...flags,'--resume',id],env);
    assert.equal(run.code,2,run.stdout+run.stderr);
    assert.match(run.stderr,/ordered prefix/);
    assert.equal(requests,0,'invalid source result ancestry must fail before SSE');
    assert.equal((await readFile(file,'utf8')).trim().split('\n').length,3,
      'rejected journal must be left intact for repair');
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});


test('real CLI refuses replay of fully preserved tool result after uncertain PostToolUse context failure', {
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-hook-context-fence-'));
  const id=randomUUID();
  let requests=0;
  const server=createServer(async(req,res)=>{
    for await(const chunk of req)void chunk;
    requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    const journal=await openSessionJournal({workspace:root,sessionId:id});
    const input=[{role:'user',content:'Write one file'}];
    const pending=[...input,{role:'assistant',content:[{
      type:'tool_use',id:'written-but-hook-context-failed',
      name:'Write',input:{file_path:'saved.txt',content:'original'},
    }]}];
    const result=[...pending,{role:'user',content:[{
      type:'tool_result',tool_use_id:'written-but-hook-context-failed',
      content:'original Write tool completed',
    }]}];
    await journal.append({messages:input,kind:'input'});
    await journal.append({messages:pending,kind:'tool_pending'});
    await journal.append({messages:result,kind:'tool_uncertain'});
    await journal.close();
    const path=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),
      ['input','tool_pending','tool_uncertain']);
    assert.equal(records[2].entries[0].sourceToolAssistantUUID,records[1].leafUuid);
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const flags=['--print','--provider','deepseek','--cwd',root,
      '--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const env={DEEPSEEK_API_KEY:'local-review-fixture'};
    const first=await childProcess([...flags,'--resume',id],env);
    const second=await childProcess([...flags,'--resume',id,'repeat Write'],env);
    assert.equal(first.code,2,first.stdout+first.stderr);
    assert.equal(second.code,2,second.stdout+second.stderr);
    assert.match(first.stderr,/completed tool results but failed Hook\/native context normalization/);
    assert.match(second.stderr,/automatic replay is unsafe/);
    assert.equal(requests,0,'neither mode may request a model replay');
    assert.deepEqual((await readFile(path,'utf8')).trim().split('\n')
      .map(JSON.parse).map(x=>x.kind),['input','tool_pending','tool_uncertain'],
      'a blocked resume must not corrupt or append to the journal');
  }finally{
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
