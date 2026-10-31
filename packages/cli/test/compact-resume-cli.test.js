import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>
  'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
const start=(inputTokens=45)=>frame('message_start',{
  message:{usage:{input_tokens:inputTokens,output_tokens:0,
    cache_creation_input_tokens:20,cache_read_input_tokens:10}},
});
const stop=reason=>frame('message_delta',{
  delta:{stop_reason:reason},usage:{output_tokens:10},
})+frame('message_stop');
function readToolRound(n){
  return start(n===3?1800:45)+
    frame('content_block_start',{index:0,
      content_block:{type:'thinking',thinking:'',signature:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'signature_delta',signature:'signed-before-compact-'+n}})+
    frame('content_block_stop',{index:0})+
    frame('content_block_start',{index:1,
      content_block:{type:'tool_use',id:'read-once-'+n,name:'Read',input:{}}})+
    frame('content_block_delta',{index:1,delta:{
      type:'input_json_delta',partial_json:'{"file_path":"note.txt"}'}})+
    frame('content_block_stop',{index:1})+stop('tool_use');
}
function answer(text){
  return start()+frame('content_block_start',{index:0,
    content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,
      delta:{type:'text_delta',text}})+
    frame('content_block_stop',{index:0})+stop('end_turn');
}
async function runCli(work,id,baseUrl,{resume=false}={}){
  const args=[cli,'--print','--provider','deepseek',
    '--compact-threshold','1200','--max-retries','0',
    '--max-turns','8','--cwd',work,'--base-url',baseUrl,
    ...(resume?['--resume',id]:['--session-id',id,
      'Read note.txt three times, and then report what changed.'])];
  const child=spawn(process.execPath,args,{
    env:{...process.env,DEEPSEEK_API_KEY:'compact-resume-local-fixture'},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',data=>{stdout+=data;});
  child.stderr.on('data',data=>{stderr+=data;});
  const watchdog=setTimeout(()=>child.kill('SIGKILL'),25000);
  try {
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(status,signal)=>resolve([status,signal]));
    });
    return {code,signal,stdout,stderr};
  }finally{
    clearTimeout(watchdog);
    if(child.exitCode===null)child.kill('SIGKILL');
  }
}

test('packed CLI resumes compacted UUID root after provider failure without replaying tool calls',{
  timeout:70000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-compact-restart-'));
  const id=randomUUID();
  const requests=[];
  const server=createServer(async(req,res)=>{
    const data=[];for await(const part of req)data.push(part);
    requests.push(JSON.parse(Buffer.concat(data).toString('utf8')));
    const n=requests.length;
    if(n===5) {
      res.writeHead(503,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'simulated provider outage after compact fsync'}}));
      return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(n<=3?readToolRound(n):
      answer(n===4?'Summary of older completed reads, retaining verified file results.'
        :'COMPACT_RESUME_FINAL_NO_TOOL_REPLAY'));
  });
  try{
    await writeFile(join(root,'note.txt'),'File was safely read; do not mutate.\n');
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const url='http://127.0.0.1:'+server.address().port+'/anthropic';
    const first=await runCli(root,id,url);
    assert.equal(first.signal,null,first.stderr);
    assert.equal(first.code,1,first.stderr);
    assert.match(first.stderr,/\[context\] compacted/);
    assert.equal(requests.length,5,
      'three completed Read rounds, one tool-free summary and one failed post-compact stream');
    assert.equal(requests[3].tools,undefined,'summary must not expose tools');
    assert.equal(requests[4].tools?.some(x=>x.name==='Read'),true);
    const path=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const before=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    const compacts=before.filter(x=>x.kind==='compact');
    assert.equal(compacts.length,1,'compact root must be durably fsynced before provider retry');
    assert.equal(compacts[0].root,true);
    assert.equal(compacts[0].entries[0].parentUuid,null);
    assert.equal(compacts[0].entries[0].logicalParentUuid,
      before[before.indexOf(compacts[0])-1].leafUuid);
    assert.equal(before.at(-1).kind,'compact');

    const next=await runCli(root,id,url,{resume:true});
    assert.equal(next.signal,null,next.stderr);
    assert.equal(next.code,0,next.stdout+next.stderr);
    assert.match(next.stdout,/COMPACT_RESUME_FINAL_NO_TOOL_REPLAY/);
    assert.equal(requests.length,6,
      'promptless resume must issue one model request and never replay any previous tool');
    const restored=requests[5].messages;
    assert.deepEqual(restored,requests[4].messages,
      'the resumed model must receive the exact same compacted context as the failed stream');
    assert.equal(restored[1].content[0].signature,'signed-before-compact-2');
    assert.equal(restored[3].content[0].signature,'signed-before-compact-3');
    assert.equal(restored[4].content[0].tool_use_id,'read-once-3');
    const after=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(after.filter(x=>x.kind==='compact').length,1);
    assert.equal(after.at(-1).kind,'finished');
    assert.equal(after.filter(x=>x.kind==='input').length,1,
      'resume after post-compact failure must not invent a new user prompt');
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
