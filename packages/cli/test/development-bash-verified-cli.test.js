import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+
  '\ndata: '+JSON.stringify({type,...data})+'\n\n';
const command='node --test src/math.test.mjs';
function toolStream({id,name,input}){
  return frame('message_start',{message:{usage:{input_tokens:46}}})+
    frame('content_block_start',{index:0,
      content_block:{type:'tool_use',id,name,input:{}}})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},
      usage:{output_tokens:12}})+frame('message_stop');
}
function finalStream(){
  const text='Verified addition fix with node --test and re-read code.';
  return frame('message_start',{message:{usage:{input_tokens:32}}})+
    frame('content_block_start',{index:0,
      content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text,
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'}})+
    frame('message_stop');
}
const original='export function add(a, b) {\n  return a - b;\n}\n';
const fixed='export function add(a, b) {\n  return a + b;\n}\n';
const spec="import {test} from 'node:test';\n"+
  "import {strict as assert} from 'node:assert';\n"+
  "import {add} from './math.mjs';\n"+
  "test('adds integers',()=>assert.equal(add(2,3),5));\n";

test('actual packed agent-cil uses original Read/Edit/Bash/Read tool chain to repair and test code, committing each result once',{
  timeout:55000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-build-verify-'));
  const id=randomUUID();
  const sequence=[
    {id:'source-read',name:'Read',
      input:{file_path:'src/math.mjs'}},
    {id:'source-edit',name:'Edit',
      input:{file_path:'src/math.mjs',
        old_string:'return a - b;',new_string:'return a + b;'}},
    {id:'source-bash-test',name:'Bash',
      input:{command}},
    {id:'source-verify-read',name:'Read',
      input:{file_path:'src/math.mjs'}},
  ];
  const requests=[];
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
    const next=sequence[requests.length-1];
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(next?toolStream(next):finalStream());
  });
  let child,watchdog;
  try{
    await mkdir(join(root,'src'));
    await writeFile(join(root,'src','math.mjs'),original);
    await writeFile(join(root,'src','math.test.mjs'),spec);
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const args=[cli,'--print','--provider','deepseek',
      '--cwd',root,'--session-id',id,
      '--max-turns','7','--max-retries','0','--compact-threshold','0',
      '--allow-edits','--allowedTools','Bash('+command+')',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Inspect math.mjs, correct its arithmetic, run node --test, then verify the saved code'];
    // This test itself runs inside node --test. Do not propagate its
    // internal runner marker into the child CLI: the CLI's Bash must launch
    // a genuine nested 'node --test', not Node's recursive-test skip path.
    // Production CLI process/env behavior is intentionally unchanged.
    const cliEnv={...process.env,DEEPSEEK_API_KEY:'development-local-only'};
    delete cliEnv.NODE_TEST_CONTEXT;
    child=spawn(process.execPath,args,{
      env:cliEnv,
      stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',x=>{stdout+=x;});
    child.stderr.on('data',x=>{stderr+=x;});
    watchdog=setTimeout(()=>child.kill('SIGKILL'),35000);
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(status,sig)=>resolve([status,sig]));
    });
    assert.equal(signal,null,stderr);
    assert.equal(code,0,stdout+stderr);
    assert.match(stdout,/Verified addition fix/);
    assert.equal(await readFile(join(root,'src','math.mjs'),'utf8'),fixed);
    assert.equal(await readFile(join(root,'src','math.test.mjs'),'utf8'),spec,
      'the test file must never be rewritten by the tool');
    assert.equal(requests.length,sequence.length+1);
    for(let i=0;i<sequence.length;i++){
      const result=requests[i+1].messages.at(-1).content.find(x=>
        x.type==='tool_result'&&x.tool_use_id===sequence[i].id);
      assert.ok(result,'missing source-mapped result '+sequence[i].id);
      assert.notEqual(result.is_error,true,
        'tool must run through permission and original result mapping: '+sequence[i].id);
      if(i===0)assert.equal(result.content,original);
      if(i===2){
        assert.match(result.content,/pass 1|1 pass|tests 1/i,
          'Bash must execute the real node --test process and preserve its stdout');
      }
      if(i===3)assert.equal(result.content,fixed);
    }
    assert.match(stderr,/auto-approved Edit/);
    const path=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind).filter(x=>x==='input'),['input']);
    assert.equal(records.filter(x=>x.kind==='tool').length,4);
    assert.equal(records.at(-1).kind,'finished');
    assert.equal(records.filter(x=>x.kind==='tool_started').length,2,
      'only the mutating Edit/Bash tools may acquire durable execution-start witnesses');
    assert.match(JSON.stringify(requests.at(-1).messages),
      /source-bash-test/,'all committed tool rounds remain in model-visible history');
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
