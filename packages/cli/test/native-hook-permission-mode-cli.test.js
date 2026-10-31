import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm,realpath,mkdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
function frame(type,data={}) {
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
}
function toolStream(id){
  return frame('message_start',{message:{usage:{input_tokens:12}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name:'Write',input:{}}})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({
        file_path:'mode-probe.txt',content:'written by CLI',
      })}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:5}})+
    frame('message_stop');
}
function answerStream(){
  return frame('message_start',{message:{usage:{input_tokens:13}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{type:'text_delta',text:'finished'}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:4}})+
    frame('message_stop');
}

async function checkMode({allowEdits,failTool=false}){
  const root=await mkdtemp(join(tmpdir(),'agent-cil-hook-mode-'));
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(requests.length===1?toolStream('mode-write'):answerStream());
  });
  let child,timer;
  try {
    const hookScript=join(root,'mode-hook.cjs');
    await writeFile(hookScript,
      "const fs=require('fs');let data='';"+
      "process.stdin.on('data',x=>data+=x);"+
      "process.stdin.on('end',()=>{const input=JSON.parse(data);"+
      "const path=input.transcript_path;"+
      "const journal=path&&fs.existsSync(path)?fs.readFileSync(path,'utf8'):'';"+
      "const checkpointKinds=journal.trim().split('\\n').filter(Boolean).map(line=>JSON.parse(line).kind);"+
      "fs.appendFileSync('hook-modes.jsonl',JSON.stringify({event:input.hook_event_name,"+
      "mode:input.permission_mode,session_id:input.session_id,"+
      "transcript_path:path,cwd:input.cwd,checkpointKinds})+'\\n');"+
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{"+
      "hookEventName:input.hook_event_name,"+
      "permissionDecision:input.hook_event_name==='PreToolUse'?'allow':undefined}}));});"
    );
    const settings=join(root,'hooks.json');
    await writeFile(settings,JSON.stringify({hooks:{
      PreToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node mode-hook.cjs',timeout:8,
      }]}],
      PostToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node mode-hook.cjs',timeout:8,
      }]}],
      PostToolUseFailure:[{matcher:'Write',hooks:[{
        type:'command',command:'node mode-hook.cjs',timeout:8,
      }]}],
    }}));
    // A directory instead of the target file guarantees a real native Write
    // error AFTER tool_started and exercises source PostToolUseFailure.
    if(failTool)await mkdir(join(root,'mode-probe.txt'));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-turns','3','--compact-threshold','0',
      '--max-retries','0','--base-url',
      'http://127.0.0.1:'+server.address().port+'/anthropic',
      '--hooks-file',settings,...(allowEdits?['--allow-edits']:[]),
      'Write the probe file'],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-test-only'},
      stdio:['ignore','pipe','pipe'],
    });
    const out=[],err=[];
    child.stdout.on('data',chunk=>out.push(chunk));
    child.stderr.on('data',chunk=>err.push(chunk));
    timer=setTimeout(()=>child.kill('SIGKILL'),17000);
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(c,s)=>resolve([c,s]));
    });
    const output=Buffer.concat(out).toString('utf8')+
      Buffer.concat(err).toString('utf8');
    assert.equal(signal,null,output);
    assert.equal(code,0,output);
    assert.equal(requests.length,2,output);
    if(failTool)assert.equal((await stat(join(root,'mode-probe.txt'))).isDirectory(),true);
    else assert.equal(await readFile(join(root,'mode-probe.txt'),'utf8'),
      'written by CLI');
    const rows=(await readFile(join(root,'hook-modes.jsonl'),'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,2,'PreToolUse and terminal original Hook must actually run');
    const session=output.match(/\[session\] ([0-9a-f-]{36}) created/);
    assert.ok(session,'CLI must announce an actual created SessionJournal');
    const canonical=await realpath(root);
    const expectedEvents=['PreToolUse',failTool?'PostToolUseFailure':'PostToolUse'];
    for(const [index,event] of expectedEvents.entries()) {
      const row=rows[index];
      assert.equal(row.event,event);
      assert.equal(row.mode,allowEdits?'acceptEdits':'default');
      assert.equal(row.session_id,session[1],
        'native Hook must observe real source session identity, not empty string');
      assert.equal(row.transcript_path,join(canonical,'.agent-cil',
        'sessions',session[1],'transcript.jsonl'),
        'Hook must reference the same locked journal as Query');
      // Windows runner may launch from the legitimate 8.3 short-name path
      // (RUNNER~1), while SessionJournal realpath canonicalizes to the
      // long-name path (runneradmin). Assert directory identity, not
      // spelling: both are the same real workspace.
      assert.equal(await realpath(row.cwd),canonical);
      assert.ok(row.checkpointKinds.includes('tool_pending'),
        'Hook must see the durably committed source assistant tool_use');
    }
    assert.equal(rows[0].checkpointKinds.includes('tool_started'),false,
      'PreToolUse fires before starting the actual tool');
    assert.ok(rows[1].checkpointKinds.includes('tool_started'),
      'PostToolUse fires after the tool started witness was committed');
    if(failTool) {
      assert.equal(rows[1].checkpointKinds.includes('tool_mapped'),false,
        'native execution errors have no successful mapped-result witness');
      const returned=requests[1].messages.at(-1).content[0];
      assert.equal(returned.is_error,true,
        'failed tool result must remain error in real provider continuation');
    }else{
      assert.ok(rows[1].checkpointKinds.includes('tool_mapped'),
        'PostToolUse must see its mapped result recovery witness before it runs');
    }
  }finally{
    if(timer)clearTimeout(timer);
    if(child&&child.exitCode===null&&!child.killed)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
test('real CLI default permission mode is supplied to both original tool Hooks',
  {timeout:30000},async()=>checkMode({allowEdits:false}));
test('real CLI acceptEdits mode reaches PreToolUse and PostToolUse without hardcoded default',
  {timeout:30000},async()=>checkMode({allowEdits:true}));
test('real CLI native PostToolUseFailure sees same session and transcript on Write error',
  {timeout:30000},async()=>checkMode({allowEdits:true,failTool:true}));
