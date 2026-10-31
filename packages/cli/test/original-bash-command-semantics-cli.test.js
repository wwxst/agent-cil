import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {interpretCommandResult} from '../src/original-bash-command-semantics.js';
import {permissionRuleValueToString} from '../../runtime/src/legacy-permissions/permission-rule-parser.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const NL=String.fromCharCode(10);
function frame(type,data={}){
  return 'event: '+type+NL+'data: '+JSON.stringify({type,...data})+NL+NL;
}
function toolStream(command){
  return frame('message_start',{message:{usage:{input_tokens:25}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id:'bash-semantic',name:'Bash',input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({command}),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'}})+
    frame('message_stop');
}
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:35}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'BASH_SOURCE_SEMANTICS_DONE',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'}})+
    frame('message_stop');
}

test('2.1.88 Bash commandSemantics retains original exit codes and avoids false failure for grep/rg/diff/test/find',()=>{
  for(const command of ['grep','rg','diff','find','test','[']){
    assert.deepEqual(interpretCommandResult(command+' sample',1,'',''),{
      isError:false,
      message:({
        grep:'No matches found',rg:'No matches found',
        diff:'Files differ',find:'Some directories were inaccessible',
        test:'Condition is false','[':'Condition is false',
      })[command],
    });
    assert.equal(interpretCommandResult(command+' sample',2,'','').isError,true);
  }
  for(const command of [
    'node -e "process.exit(1)"','false',
    'grep sample | node -e "process.exit(1)"',
    'grep sample && node -e "process.exit(1)"',
    'grep sample > redirect.txt',
  ]) {
    assert.equal(interpretCommandResult(command,1,'','').isError,true,
      'ambiguous compound/operator semantics must never mark a failed command successful');
  }
  assert.equal(interpretCommandResult('node --version',0,'v22','').isError,false);
});

async function runBashViaInstalledCli({command,expectedError,expectedHook,expectedCode}){
  const root=await mkdtemp(join(tmpdir(),'agent-source-bash-status-'));
  const requests=[];
  let server,child,watchdog;
  try {
    // Source Pre/Post Hook runs through the same real SessionJournal and
    // Command Hook stdin as an interactive session, not a direct stub.
    await writeFile(join(root,'hook.cjs'),
      "let s='';process.stdin.on('data',x=>s+=x);"+
      "process.stdin.on('end',()=>{let v=JSON.parse(s);"+
      "require('node:fs').writeFileSync('observed-hook.json',"+
      "JSON.stringify({event:v.hook_event_name,code:v.error,tool_use_id:v.tool_use_id}));"+
      "process.stdout.write('{}');});");
    await writeFile(join(root,'hooks.json'),JSON.stringify({hooks:{
      PostToolUse:[{matcher:'Bash',hooks:[{
        type:'command',command:'node hook.cjs',timeout:8,
      }]}],
      PostToolUseFailure:[{matcher:'Bash',hooks:[{
        type:'command',command:'node hook.cjs',timeout:8,
      }]}],
    }}));
    server=createServer(async(req,res)=>{
      const chunks=[];for await(const part of req)chunks.push(part);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(requests.length===1?toolStream(command):finalStream());
    });
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const rule=permissionRuleValueToString({toolName:'Bash',ruleContent:command});
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-retries','0','--max-turns','3',
      '--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      '--allowedTools',rule,'--hooks-file',join(root,'hooks.json'),
      'Run a single command then report status'],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-semantic-fixture'},
      stdio:['ignore','pipe','pipe'],
    });
    const output=[],errors=[];
    child.stdout.on('data',x=>output.push(x));
    child.stderr.on('data',x=>errors.push(x));
    watchdog=setTimeout(()=>child.kill('SIGKILL'),22000);
    const [status,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(c,s)=>resolve([c,s]));
    });
    const stdout=Buffer.concat(output).toString('utf8');
    const stderr=Buffer.concat(errors).toString('utf8');
    assert.equal(signal,null,stderr);
    assert.equal(status,0,stderr);
    assert.match(stdout,/BASH_SOURCE_SEMANTICS_DONE/);
    assert.equal(requests.length,2,'no retry or silently dropped error result');
    const result=requests[1].messages.at(-1).content.find(
      block=>block.type==='tool_result'&&block.tool_use_id==='bash-semantic');
    assert.ok(result,'tool ID must be preserved in actual provider request');
    assert.equal(result.is_error===true,expectedError,JSON.stringify(result));
    assert.match(result.content,new RegExp(String(expectedCode)));
    const hook=JSON.parse(await readFile(join(root,'observed-hook.json'),'utf8'));
    assert.equal(hook.event,expectedHook);
    assert.equal(hook.tool_use_id,'bash-semantic');
    if(expectedError)assert.match(hook.code,/Command failed|exit code/i);
    return result;
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server?.closeAllConnections?.();
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

test('real CLI Bash exit 0 retains original successful PostToolUse and output',{
  timeout:35000,
},async()=>{
  await runBashViaInstalledCli({
    command:'node --version',expectedError:false,
    expectedHook:'PostToolUse',expectedCode:'v[0-9]+',
  });
});
test('real CLI Bash exit 7 triggers original PostToolUseFailure and model-visible is_error',{
  timeout:35000,
},async()=>{
  await runBashViaInstalledCli({
    command:'node -e "process.stdout.write(\'STATUS_MARK\');process.exit(7)"',
    expectedError:true,
    expectedHook:'PostToolUseFailure',expectedCode:'STATUS_MARK',
  });
});
if(process.platform!=='win32'){
  test('real CLI grep exit 1 means no matches, not PostToolUseFailure',{
    timeout:35000,
  },async()=>{
    await runBashViaInstalledCli({
      // Source PATH_EXTRACTORS.grep() classifies an explicit /dev/null
      // operand as a file-read path, requiring validatePath. Use genuine
      // empty inherited stdin to test source exit-1 / PostToolUse semantics
      // independently of the still-unported filesystem permission closure.
      command:'grep NO_UNLIKELY_MATCH',
      expectedError:false,expectedHook:'PostToolUse',
      expectedCode:'No matches found',
    });
  });
}
