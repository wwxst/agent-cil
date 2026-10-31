import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+'\ndata: '+
  JSON.stringify({type,...data})+'\n\n';
const requestWrite=()=>frame('message_start',{message:{usage:{input_tokens:30}}})+
  frame('content_block_start',{index:0,content_block:{
    type:'tool_use',id:'post-join-write',name:'Write',input:{},
  }})+
  frame('content_block_delta',{index:0,delta:{
    type:'input_json_delta',partial_json:JSON.stringify({
      file_path:'result.txt',content:'native file written before PostToolUse',
    }),
  }})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:10}})+
  frame('message_stop');

// The released CLI's executeHooks starts every matching PostToolUse command.
// One hook's continue:false must not commit tool_result or release the CLI
// while a sibling already-started command is still mutating the workspace.
test('installed CLI preserves original PostToolUse parallel hook ownership until last command finishes',{
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-packed-post-join-'));
  const sessionId=randomUUID();
  let requests=0,child,closed,watchdog;
  const server=createServer(async(req,res)=>{
    for await(const chunk of req)void chunk;
    requests++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(requestWrite());
  });
  try{
    await writeFile(join(root,'stop-hook.cjs'),
      "console.log(JSON.stringify({continue:false,stopReason:'Stop after approved Write'}));");
    await writeFile(join(root,'slow-hook.cjs'),[
      "const fs=require('node:fs');",
      "setTimeout(()=>{",
      "  const data=fs.readFileSync('.agent-cil/sessions/"+sessionId+"/transcript.jsonl','utf8');",
      "  const records=data.trim().split('\\n').map(x=>JSON.parse(x));",
      "  const toolCommitted=records.some(x=>x.kind==='tool');",
      "  fs.writeFileSync('slow-posthook-witness.json',JSON.stringify({toolCommitted}));",
      "  console.log('SIBLING_HOOK_COMPLETED');",
      "},800);",
    ].join('\n'));
    await writeFile(join(root,'hooks.json'),JSON.stringify({hooks:{
      PostToolUse:[{matcher:'Write',hooks:[
        {type:'command',command:'node stop-hook.cjs',timeout:10},
        {type:'command',command:'node slow-hook.cjs',timeout:10},
      ]}],
    }}));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--session-id',sessionId,'--allow-edits',
      '--max-turns','3','--max-retries','0','--compact-threshold','0',
      '--hooks-file',join(root,'hooks.json'),
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Write the file and run all original PostToolUse hooks'],{
      stdio:['ignore','pipe','pipe'],
      env:{...process.env,DEEPSEEK_API_KEY:'local-posthook-join-key'},
    });
    const out=[],err=[];
    child.stdout.on('data',chunk=>out.push(chunk));
    child.stderr.on('data',chunk=>err.push(chunk));
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),30000);
    const result=await closed;
    const stdout=Buffer.concat(out).toString('utf8');
    const stderr=Buffer.concat(err).toString('utf8');
    assert.equal(result.signal,null,stderr+stdout);
    assert.equal(result.code,0,stderr+stdout);
    assert.equal(requests,1,
      'the first PostToolUse stop must prevent another model request');
    assert.equal(await readFile(join(root,'result.txt'),'utf8'),
      'native file written before PostToolUse');
    assert.deepEqual(JSON.parse(await readFile(join(root,'slow-posthook-witness.json'),'utf8')),
      {toolCommitted:false},
      'session tool commit must NOT overtake sibling Hook side effects');
    const records=(await readFile(join(root,'.agent-cil','sessions',
      sessionId,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(x=>x.kind),
      ['input','tool_pending','tool_started','tool_mapped','tool']);
    assert.equal(records.at(-1).entries[0].message.content[0].tool_use_id,'post-join-write');
  }finally {
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
});
