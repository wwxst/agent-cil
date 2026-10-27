import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOriginalBashForSecurity} from
  '../../runtime/src/legacy-permissions/bash-original-ast-security.js';
import {bashToolCheckAstPermission} from
  '../../runtime/src/legacy-permissions/bash-ast-permission.js';
import {createCliPermissionContext,parseArgs} from '../src/index.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const LF=String.fromCharCode(10);
function frame(type,data={}){
  return 'event: '+type+LF+'data: '+JSON.stringify({type,...data})+LF+LF;
}
const stream=command=>
  frame('message_start',{message:{usage:{input_tokens:17}}})+
  frame('content_block_start',{index:0,content_block:{
    type:'tool_use',id:'source-ast-bash',name:'Bash',input:{},
  }})+
  frame('content_block_delta',{index:0,delta:{
    type:'input_json_delta',partial_json:JSON.stringify({command}),
  }})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'tool_use'}})+
  frame('message_stop');
const finalStream=()=>
  frame('message_start',{message:{usage:{input_tokens:19}}})+
  frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
  frame('content_block_delta',{index:0,delta:{
    type:'text_delta',text:'ORIGINAL_BASH_AST_VERIFIED',
  }})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'end_turn'}})+
  frame('message_stop');

test('actual pinned 2.1.88 Bash AST produces structured argv and original subcommand positions',{
  timeout:30000,
},async()=>{
  const simple=await parseOriginalBashForSecurity('node --version');
  assert.equal(simple.kind,'simple',JSON.stringify(simple));
  assert.deepEqual(simple.commands.map(x=>x.argv),[['node','--version']]);
  const compound=await parseOriginalBashForSecurity('echo harmless && node --version');
  assert.equal(compound.kind,'simple',JSON.stringify(compound));
  assert.deepEqual(compound.commands.map(x=>x.argv[0]),['echo','node']);
  assert.equal(compound.commands[1].text.startsWith('node'),true);
  // The original source checks parse ambiguities, command substitution,
  // control-flow and unusual shell syntax instead of regex-based auto allow.
  for(const command of [
    'echo $(node --version)',
    'eval something',
    'bash -c "node --version"',
  ]) {
    const decision=await parseOriginalBashForSecurity(command);
    assert.notEqual(decision.kind,'parse-unavailable',command);
  }
});

test('original AST integrates with pinned Bash deny/ask rule parser; complex commands never auto-allow',{
  timeout:30000,
},async()=>{
  const ctx=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}],
    deny:[{toolName:'Bash',ruleContent:'node:*'}],
    ask:[],
  }});
  const checked=await bashToolCheckAstPermission({
    command:'echo harmless && node --version',
  },ctx);
  assert.equal(checked.behavior,'deny',JSON.stringify(checked));
  const ordinary=await bashToolCheckAstPermission({
    command:'node --version',
  },createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash',ruleContent:'node --version'}],deny:[],ask:[],
  }}));
  assert.equal(ordinary.behavior,'allow',JSON.stringify(ordinary));
  // The AST cannot justify automatic broad prefix/wildcard authorization
  // until original redirection/path validation and sandbox checks are ported.
  assert.throws(()=>parseArgs([
    '--allowedTools','Bash(node:*)','test',
  ]),/wildcard\/prefix/);
});

async function testActualCli({command,flags,shouldFail}) {
  const root=await mkdtemp(join(tmpdir(),'agent-bash-ast-cli-'));
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(requests.length===1?stream(command):finalStream());
  });
  let child,timeout;
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-turns','3','--max-retries','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      ...flags,'exercise original Bash source AST'],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-ast-test'},
      stdio:['ignore','pipe','pipe'],
    });
    const output=[],errors=[];
    child.stdout.on('data',x=>output.push(x));
    child.stderr.on('data',x=>errors.push(x));
    timeout=setTimeout(()=>child.kill('SIGKILL'),25000);
    const [status,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(c,s)=>resolve([c,s]));
    });
    const stdout=Buffer.concat(output).toString('utf8'),
      stderr=Buffer.concat(errors).toString('utf8');
    assert.equal(signal,null,stderr);
    assert.equal(status,0,stderr);
    assert.match(stdout,/ORIGINAL_BASH_AST_VERIFIED/);
    assert.equal(requests.length,2);
    const result=requests[1].messages.at(-1).content.find(
      x=>x.type==='tool_result'&&x.tool_use_id==='source-ast-bash');
    assert.ok(result,'real Query must retain original authenticated tool ID');
    assert.equal(result.is_error===true,shouldFail,JSON.stringify(result));
    return {root,output:result.content};
  }finally{
    if(timeout)clearTimeout(timeout);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
test('packed real CLI: exact permitted Bash still executes with original AST preflight',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'node --version',
    flags:['--allowedTools','Bash(node --version)'],
    shouldFail:false,
  });
  assert.match(result.output,/v[0-9]+/);
});
test('packed real CLI: whole Bash allow cannot bypass AST subcommand deny in compound',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'echo harmless && node --version',
    flags:['--allowedTools','Bash','--disallowedTools','Bash(node:*)'],
    shouldFail:true,
  });
  assert.match(result.output,/denied|approval|requires/i);
});
