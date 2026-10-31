import assert from 'node:assert/strict';
import {test} from 'node:test';
// These pre-Ink acceptance cases verify the real original readline fallback.
// Ink is the default CLI and has separate Linux PTY / Windows ConPTY cases.
process.env.AGENT_CIL_TUI = 'readline';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+'\ndata: '+
  JSON.stringify({type,...data})+'\n\n';
function toolStream(id,name,input){
  return frame('message_start',{message:{usage:{input_tokens:47}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name,input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:13}})+
    frame('message_stop');
}
function answer(){
  return frame('message_start',{message:{usage:{input_tokens:70}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'DURABLE_NOTICE_CONTINUATION_OK',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:20}})+
    frame('message_stop');
}

// A genuine TTY is necessary to exercise the SAME-process REPL catch path,
// not merely --resume in a second CLI process. The original query.ts queues
// completed LocalShellTask notices before the next model request; its
// sessionStorage.ts chain, not a previous turnFinished event, is authoritative.
test('interactive CLI retains fsynced task notification after HTTP 503 and accepts the first next prompt',{
  timeout:50000,skip:process.platform==='win32',
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-tty-notice-recovery-'));
  const sessionId=randomUUID();
  const command='node notify-before-provider-failure.cjs';
  const requests=[];
  let child,closed,watchdog;
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const round=requests.length;
    if(round===1) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(toolStream('notice-bg-tool','Bash',{
        command,run_in_background:true,timeout_ms:9000,
      }));
    }else if(round===2) {
      // Source LocalShellTask completes while an unrelated Read model
      // request is still streaming; the pending notification must be
      // checkpointed at the NEXT provider boundary, i.e. round 3.
      await new Promise(resolve=>setTimeout(resolve,1400));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(toolStream('notice-read-tool','Read',{
        file_path:'notify-before-provider-failure.cjs',offset:0,limit:1,
      }));
    }else if(round===3) {
      assert.match(JSON.stringify(body.messages),/<task_notification>/,
        'native task notice must be in the failing provider request');
      res.writeHead(503,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:'simulated model outage after durable notice'}}));
    }else {
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(answer());
    }
  });
  let output='',errors='',sentContinuation=false,sentExit=false;
  const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  try{
    await writeFile(join(root,'notify-before-provider-failure.cjs'),[
      "process.stdout.write('BG_STARTED\\n');",
      "setTimeout(()=>{process.stdout.write('BG_DONE\\n');process.exit(0)},450);",
    ].join('\n'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const argv=[process.execPath,cli,
      '--provider','deepseek','--cwd',root,'--session-id',sessionId,
      '--max-retries','0','--compact-threshold','0','--max-turns','5',
      '--allowedTools','Bash('+command+')',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Start a short background Bash and read its script.'];
    child=spawn('script',['-q','-e','-c',argv.map(shellQuote).join(' '),'/dev/null'],{
      env:{...process.env,DEEPSEEK_API_KEY:'tty-native-notice-fixture'},
      stdio:['pipe','pipe','pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',data=>{
      output+=data;
      const prompts=output.split('you> ').length-1;
      if(prompts>=1&&!sentContinuation){
        sentContinuation=true;
        child.stdin.write('Continue after the provider outage\n');
      }else if(prompts>=2&&!sentExit){
        sentExit=true;
        child.stdin.write('/exit\n');
      }
    });
    child.stderr.on('data',data=>{errors+=data;});
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),33000);
    const result=await closed;
    assert.equal(result.signal,null,errors+output);
    assert.equal(result.code,0,errors+output);
    assert.ok(sentContinuation&&sentExit,'REPL must accept one next prompt and exit');
    assert.equal(requests.length,4,
      'the FIRST new prompt must call the provider; no stale-history failed append');
    assert.match(output,/DURABLE_NOTICE_CONTINUATION_OK/);
    assert.doesNotMatch(output,/Noncompact transcript rewrites are denied|Noncompact transcript mutation|history rewrites|source parent chain reconstruction changed/i);
    const continued=JSON.stringify(requests[3].messages);
    assert.match(continued,/<task_notification>/,
      'the recovered API context retains the already fsynced task notice');
    assert.match(continued,/Continue after the provider outage/);
    assert.equal((continued.match(/notice-bg-tool/g)??[]).length>=1,true,
      'the original Bash tool result is preserved, not replayed');
    const transcript=(await readFile(join(root,'.agent-cil','sessions',
      sessionId,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(transcript.filter(r=>r.kind==='task_notification').map(r=>r.kind),
      ['task_notification'],'one native completion notification is durably recorded');
    assert.equal(transcript.filter(r=>r.kind==='input').length,2,
      'original prompt and first subsequent REPL prompt each have one durable checkpoint');
    assert.equal(transcript.at(-1).kind,'finished');
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
