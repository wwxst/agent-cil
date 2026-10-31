import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,realpath,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {openSessionJournal} from '../../runtime/src/legacy-session/session-storage.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,body={})=>'event: '+type+'\ndata: '+
  JSON.stringify({type,...body})+'\n\n';
function toolStream(id,command){
  return frame('message_start',{message:{usage:{input_tokens:26}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name:'Bash',input:{},
    }})+frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',
      partial_json:JSON.stringify({command,timeout_ms:10000}),
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:8}})+
    frame('message_stop');
}
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:35}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'INVALID_SECOND_ROUND',
    }})+frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'}})+frame('message_stop');
}

test('npm-installed CLI retains Bash executing witness and fences model after finalized output truncation',{
  timeout:44000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-native-output-final-cli-'));
  const id=randomUUID();
  const command='node finalized-bash.cjs';
  let calls=0;
  const server=createServer(async(req,res)=>{
    for await(const _ of req){}
    calls++;
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(calls===1?toolStream('bash-finalized-output',command):finalStream());
  });
  let child,closed,watchdog;
  try{
    await writeFile(join(root,'finalized-bash.cjs'),[
      "const fs=require('node:fs');",
      "fs.writeFileSync('real-side-effect.txt','executed once');",
      "process.stdout.write('ACTUAL_OS_BASH_OUTPUT_COMPLETE');",
    ].join('\n'));
    const installed=await realpath(cli);
    const moduleUrl=pathToFileURL(join(dirname(installed),
      'legacy-task-output.js')).href;
    const preloader=join(root,'truncate-after-native-flush.mjs');
    await writeFile(preloader,[
      "import {truncate} from 'node:fs/promises';",
      'const {TaskOutput}=await import('+JSON.stringify(moduleUrl)+');',
      'const old=TaskOutput.prototype.getStdout;',
      'TaskOutput.prototype.getStdout=async function(...args){',
      ' if(this.stdoutToFile)await truncate(this.path,1);',
      ' return old.apply(this,args);',
      '};',
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[
      '--import',pathToFileURL(preloader).href,cli,
      '--print','--provider','deepseek','--cwd',root,
      '--session-id',id,'--max-retries','0','--max-turns','3',
      '--compact-threshold','0','--allowedTools','Bash('+command+')',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Run Bash and report exactly what it returned',
    ],{
      stdio:['ignore','pipe','pipe'],windowsHide:true,
      env:{...process.env,DEEPSEEK_API_KEY:'only-local-finalized-fence'},
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
    watchdog=setTimeout(()=>child.kill('SIGKILL'),24000);
    const result=await closed;
    assert.equal(result.signal,null,stderr);
    assert.equal(result.code,1,stdout+stderr);
    assert.equal(calls,1,'a truncated completed Bash log forbids next provider call');
    assert.match(await readFile(join(root,'real-side-effect.txt'),'utf8'),/executed once/);
    assert.match(stderr,/Bash TaskOutput file length changed after native finalization/);
    assert.doesNotMatch(stdout,/INVALID_SECOND_ROUND/);
    const transcript=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const records=(await readFile(transcript,'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.some(x=>x.kind==='tool_pending'));
    assert.equal(records.at(-1).kind,'tool_started');
    assert.equal(records.filter(x=>x.kind==='tool').length,0);
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    try{assert.equal(reopened.needsToolReconciliation,true);}
    finally{await reopened.close();}
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
