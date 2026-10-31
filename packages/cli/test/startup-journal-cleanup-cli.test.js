import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {openSessionJournal} from '../../runtime/src/legacy-session/session-storage.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+'\ndata: '+
  JSON.stringify({type,...data})+'\n\n';
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:7}}})+
    frame('content_block_start',{index:0,
      content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'SETUP_ERROR_RECOVERED_WITH_PRIOR_CONTEXT',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},
      usage:{output_tokens:3}})+frame('message_stop');
}
async function runCli(args,{preloader,env={}}={}){
  const argv=[
    ...(preloader?['--import',preloader]:[]),cli,...args,
  ];
  const child=spawn(process.execPath,argv,{
    env:{...process.env,ANTHROPIC_API_KEY:'local-setup-fixture-key',
      DEEPSEEK_API_KEY:'local-setup-fixture-key',...env},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data',data=>{stdout+=data;});
  child.stderr.on('data',data=>{stderr+=data;});
  const watchdog=setTimeout(()=>child.kill('SIGKILL'),20000);
  try {
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve([code,signal]));
    });
    return {code,signal,stdout,stderr};
  }finally{
    clearTimeout(watchdog);
    if(child.exitCode===null)child.kill('SIGKILL');
  }
}

/**
 * An actual non-mocked installed CLI is run twice. The first process fails
 * AFTER createBuiltinTools() and new AgentLoop() but BEFORE entering Query.
 * A preloaded Node event registration fault is independent of production
 * CLI code: it exercises a setup exception across its real finally boundary.
 */
test('startup failure after journal lock releases SIGINT, Task owner and lock; another CLI process resumes same source conversation',{
  timeout:50000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-startup-failure-'));
  const id=randomUUID();
  let journal;
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    // This is an authentic committed 2.1.88-style session. A failed
    // startup must not destroy or rewrite its old source UUID message chain.
    journal=await openSessionJournal({workspace:root,sessionId:id});
    const prior=[
      {role:'user',content:'Original task must remain saved.'},
      {role:'assistant',content:[{type:'text',text:'Original work completed.'}]},
    ];
    await journal.append({messages:prior,kind:'finished'});
    const path=journal.path;
    await journal.close();journal=null;
    const before=await readFile(path,'utf8');
    const preloader=join(root,'inject-signal-registration-failure.mjs');
    await writeFile(preloader,[
      'const originalOn=process.on;',
      'let thrown=false;',
      'process.on=function(event,...args){',
      "  if(event==='SIGTERM' && !thrown){",
      '    thrown=true;',
      '    process.on=originalOn;',
      "    throw Error('INJECTED_POST_JOURNAL_STARTUP_ERROR');",
      '  }',
      '  return Reflect.apply(originalOn,this,[event,...args]);',
      '};',
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const args=['--print','--provider','deepseek','--cwd',root,
      '--resume',id,'--compact-threshold','0','--max-retries','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Continue after a previous process setup failure'];
    const failed=await runCli(args,{preloader});
    assert.equal(failed.signal,null,failed.stderr);
    assert.equal(failed.code,1,failed.stderr);
    assert.match(failed.stderr,/INJECTED_POST_JOURNAL_STARTUP_ERROR/,
      'the actual startup after session lock must throw before Query');
    assert.match(failed.stderr,new RegExp('\\[session\\] '+id+' resumed'),
      'failure injection must occur AFTER the journal was opened and verified');
    assert.equal(requests.length,0,'no provider request before Query begins');
    assert.equal(await readFile(path,'utf8'),before,
      'failed initialization must never mutate committed transcript');
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'},
      'original source lock must be released before process exits');
    const recovered=await runCli(args);
    assert.equal(recovered.signal,null,recovered.stderr);
    assert.equal(recovered.code,0,recovered.stderr+recovered.stdout);
    assert.match(recovered.stdout,/SETUP_ERROR_RECOVERED_WITH_PRIOR_CONTEXT/);
    assert.equal(requests.length,1,
      'second process must not replay or duplicate any provider request');
    const next=JSON.stringify(requests[0].messages);
    assert.match(next,/Original task must remain saved/);
    assert.match(next,/Original work completed/);
    assert.match(next,/Continue after a previous process setup failure/);
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['finished','input','finished'],
      'only resumed user prompt and final response are committed');
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'});
  }finally{
    if(journal)await journal.close().catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});


test('first user input survives a new CLI setup exception and --resume sends it exactly once',{
  timeout:50000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-new-input-startup-'));
  const id=randomUUID();
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    const preloader=join(root,'fail-new-session-after-lock.mjs');
    await writeFile(preloader,[
      'const originalOn=process.on;',
      'let failed=false;',
      'process.on=function(name,...args){',
      "  if(name==='SIGTERM'&&!failed){",
      '    failed=true;',
      '    process.on=originalOn;',
      "    throw Error('STARTUP_AFTER_FIRST_INPUT_CRASH');",
      '  }',
      '  return Reflect.apply(originalOn,this,[name,...args]);',
      '};',
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const base=['--print','--provider','deepseek',
      '--cwd',root,'--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic'];
    const originalPrompt='Implement the first requested code edit safely after startup.';
    const failed=await runCli([...base,'--session-id',id,originalPrompt],{preloader});
    assert.equal(failed.signal,null,failed.stderr);
    assert.equal(failed.code,1,failed.stderr);
    assert.match(failed.stderr,/STARTUP_AFTER_FIRST_INPUT_CRASH/);
    assert.match(failed.stderr,new RegExp('\\[session\\] '+id+' created'),
      'fault must occur after original SessionJournal creates its locked file');
    assert.equal(requests.length,0,
      'startup crash must never reach model or execute a side-effecting tool');
    const path=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const original=await readFile(path,'utf8');
    const records=original.trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),['input'],
      'initial input must be fsynced before fallible tool/agent setup');
    assert.equal(records[0].root,true);
    assert.equal(records[0].entries.length,1);
    assert.equal(records[0].entries[0].message.content,originalPrompt);
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'});
    // Do not permit recreating the same session ID and overwriting the
    // authenticated old prompt. Source 2.1.88 resumes instead.
    const alreadyExists=await runCli([...base,'--session-id',id,
      'Should never replace saved first input']);
    assert.equal(alreadyExists.code,2,alreadyExists.stderr);
    assert.equal(await readFile(path,'utf8'),original);
    assert.equal(requests.length,0);

    const resumed=await runCli([...base,'--resume',id]);
    assert.equal(resumed.signal,null,resumed.stderr);
    assert.equal(resumed.code,0,resumed.stderr+resumed.stdout);
    assert.match(resumed.stdout,/SETUP_ERROR_RECOVERED_WITH_PRIOR_CONTEXT/);
    assert.equal(requests.length,1);
    assert.deepEqual(requests[0].messages,[
      {role:'user',content:originalPrompt},
    ],'source Query must consume the exact durable original input once');
    const after=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(after.map(x=>x.kind),['input','finished'],
      'promptless resume must not invent another user message');
    assert.equal(after[1].entries[0].message.role,'assistant');
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'});
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

test('empty pre-input session remains fail-closed on --resume rather than trusting a zero-byte transcript',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-untrusted-empty-'));
  const id=randomUUID();
  let journal;
  try{
    journal=await openSessionJournal({workspace:root,sessionId:id});
    const path=journal.path;
    await journal.close();journal=null;
    assert.equal(await readFile(path,'utf8'),'');
    await assert.rejects(
      openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Session has no complete checkpoint/,
    );
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'});
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
