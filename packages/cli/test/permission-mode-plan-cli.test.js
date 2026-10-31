import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs,createCliPermissionContext,createCliPermissionPolicy} from '../src/index.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const LF=String.fromCharCode(10);
const frame=(type,data={})=>'event: '+type+LF+'data: '+
  JSON.stringify({type,...data})+LF+LF;
function toolStream(id,name,input){
  return frame('message_start',{message:{usage:{input_tokens:13}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name,input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:5}})+
    frame('message_stop');
}
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:20}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{type:'text_delta',text:'SOURCE_PERMISSION_MODES_VERIFIED'}})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:8}})+
    frame('message_stop');
}

test('source PermissionUpdate CLI option selects all three modes, rejects contradictory or unsafe mode flags',async()=>{
  assert.equal(parseArgs(['prompt']).permissionMode,'default');
  assert.equal(parseArgs(['--allow-edits','prompt']).permissionMode,'acceptEdits');
  assert.equal(parseArgs(['--permission-mode','acceptEdits','prompt']).permissionMode,'acceptEdits');
  assert.equal(parseArgs(['--permission-mode=plan','prompt']).permissionMode,'plan');
  assert.equal(parseArgs(['--permission-mode=default','prompt']).permissionMode,'default');
  for(const args of [
    ['--permission-mode','bypassPermissions','prompt'],
    ['--permission-mode','dontAsk','prompt'],
    ['--permission-mode=','prompt'],
    ['--permission-mode','plan','--allow-edits','prompt'],
    ['--allow-edits','--permission-mode=default','prompt'],
  ])assert.throws(()=>parseArgs(args),/permission-mode|allow-edits/);
  const plan=createCliPermissionContext({permissionMode:'plan',permissionRules:{
    allow:[{toolName:'Write'},{toolName:'Bash'}],
  }});
  assert.equal(plan.mode,'plan');
  const policy=createCliPermissionPolicy({workspace:process.cwd(),permissionContext:plan});
  for(const name of ['Write','Edit','Bash','TaskStop']){
    assert.equal((await policy({name,input:{command:'node malicious.js',file_path:'real.txt'}})).behavior,'deny',
      'whole-tool allow may not bypass source plan mutation boundary');
  }
  // The mature 2.1.88 BashTool.isReadOnly() decision is reachable in plan
  // mode AFTER source AST, misparsing, scoped path, redirection and explicit
  // rule checks; whole Bash allow must never bless the opposite case.
  const readonly=await policy({name:'Bash',input:{command:'echo PLAN_MODE_SAFE_READ'}});
  assert.equal(readonly.behavior,'allow',JSON.stringify(readonly));
  assert.equal(readonly.decisionReason?.reason,'Read-only command is allowed');
  for(const input of [
    {command:'echo PLAN_MODE_SAFE_READ',run_in_background:true},
    {command:'echo SIDE_EFFECT > plan-side-effect.txt'},
    {command:'node -e "require(\'fs\').writeFileSync(\'plan-side-effect.txt\',\'FAIL\')"'},
  ]){
    const decision=await policy({name:'Bash',input});
    assert.equal(decision.behavior,'deny',JSON.stringify({input,decision}));
  }
});

async function runRealCliMode(mode){
  const root=await mkdtemp(join(tmpdir(),'agent-source-mode-real-'));
  const requests=[];
  const command='node should-never-execute.cjs';
  const steps=mode==='plan'
    ? [
      ['source-read','Read',{file_path:'existing.txt'}],
      ['source-readonly-bash','Bash',{command:'echo PLAN_MODE_SAFE_READ'}],
      ['source-write','Write',{file_path:'existing.txt',content:'overwrite forbidden'}],
      ['source-bash','Bash',{command}],
      ['source-redirect','Bash',{command:'echo FORBIDDEN > plan-side-effect.txt'}],
      ['source-background','Bash',{command:'echo PLAN_MODE_SAFE_READ',run_in_background:true}],
      ['source-taskstop','TaskStop',{task_id:'unowned'}],
    ]
    : [['source-write','Write',{file_path:'new-file.txt',content:'write permitted'}]];
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const step=steps[requests.length-1];
    res.end(step?toolStream(...step):finalStream());
  });
  let child,watchdog;
  try{
    await writeFile(join(root,'existing.txt'),'original never replaced');
    await writeFile(join(root,'should-never-execute.cjs'),
      "require('node:fs').writeFileSync('shell-effect.txt','should never run');");
    await writeFile(join(root,'allow-hook.cjs'),
      "let data='';process.stdin.on('data',x=>data+=x);"+
      "process.stdin.on('end',()=>{const input=JSON.parse(data);"+
      "require('node:fs').writeFileSync('hook-mode.json',"+
      "JSON.stringify({mode:input.permission_mode,event:input.hook_event_name}));"+
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{"+
      "hookEventName:'PreToolUse',permissionDecision:'allow'}}));});"
    );
    await writeFile(join(root,'hooks.json'),JSON.stringify({hooks:{
      PreToolUse:[{matcher:'Write',hooks:[{
        type:'command',command:'node allow-hook.cjs',timeout:8,
      }]}],
    }}));
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--compact-threshold','0','--max-turns','10',
      '--max-retries','0','--permission-mode',mode,
      '--allowedTools','Write','--allowedTools','Bash',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      '--hooks-file',join(root,'hooks.json'),
      'Exercise source CLI permission mode '+mode],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-fixture-only'},
      stdio:['ignore','pipe','pipe'],
    });
    const stdout=[],stderr=[];
    child.stdout.on('data',x=>stdout.push(x));
    child.stderr.on('data',x=>stderr.push(x));
    watchdog=setTimeout(()=>child.kill('SIGKILL'),24000);
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(c,s)=>resolve([c,s]));
    });
    const output=Buffer.concat(stdout).toString('utf8')+
      Buffer.concat(stderr).toString('utf8');
    assert.equal(signal,null,output);
    assert.equal(code,0,output);
    assert.equal(requests.length,steps.length+1,output);
    assert.match(output,/SOURCE_PERMISSION_MODES_VERIFIED/);
    const hook=JSON.parse(await readFile(join(root,'hook-mode.json'),'utf8'));
    assert.equal(hook.mode,mode,'original Hook stdin observes real selected mode');
    assert.equal(hook.event,'PreToolUse');
    if(mode==='plan') {
      assert.equal(requests[1].messages.at(-1).content[0].is_error,undefined);
      assert.match(JSON.stringify(requests[1].messages),/original never replaced/);
      const readonly=requests[2].messages.at(-1).content[0];
      assert.equal(readonly.is_error,undefined,
        'plan-mode source-approved read-only Bash should execute in the real CLI');
      assert.match(JSON.stringify(readonly.content),/PLAN_MODE_SAFE_READ/);
      for(const index of [3,4,5,6,7]){
        const result=requests[index].messages.at(-1).content[0];
        assert.equal(result.is_error,true,'plan tool '+index+' must never mutate');
        assert.match(result.content,/Plan mode does not authorize/);
      }
      assert.equal(await readFile(join(root,'existing.txt'),'utf8'),'original never replaced');
      await assert.rejects(stat(join(root,'shell-effect.txt')),{code:'ENOENT'});
      await assert.rejects(stat(join(root,'new-file.txt')),{code:'ENOENT'});
      await assert.rejects(stat(join(root,'plan-side-effect.txt')),{code:'ENOENT'});
    } else {
      const result=requests[1].messages.at(-1).content[0];
      assert.equal(result.is_error,undefined);
      assert.equal(await readFile(join(root,'new-file.txt'),'utf8'),'write permitted');
    }
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
test('packed real CLI plan mode executes original read-only Bash but denies writes, redirects, background Bash, TaskStop and Hook allow',{
  timeout:45000,
},async()=>runRealCliMode('plan'));
test('packed real CLI acceptEdits selection uses original setMode and gives Hooks actual permission_mode',{
  timeout:45000,
},async()=>runRealCliMode('acceptEdits'));
