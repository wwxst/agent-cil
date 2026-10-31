import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  MODEL_ALIASES,isModelAlias,parseUserSpecifiedModel,
  getRuntimeMainLoopModel,resolveOriginalCliModel,
} from '../../runtime/src/legacy-original/model-aliases.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const LF='\n';
const frame=(type,data={})=>'event: '+type+LF+'data: '+
  JSON.stringify({type,...data})+LF+LF;
function finalStream(){
  return frame('message_start',{message:{usage:{input_tokens:12}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'MODEL_ALIAS_ROUND_OK',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:6}})+
    frame('message_stop');
}
test('pinned 2.1.88 parseUserSpecifiedModel retains original alias families, custom casing and mode adjustments',()=>{
  assert.deepEqual(MODEL_ALIASES,[
    'sonnet','opus','haiku','best','sonnet[1m]','opus[1m]','opusplan',
  ]);
  assert.equal(isModelAlias('sonnet'),true);
  assert.equal(isModelAlias('Sonnet'),false);
  const env={};
  for(const [input,model] of [
    ['sonnet','claude-sonnet-4-6'],
    [' SONNET ','claude-sonnet-4-6'],
    ['opus','claude-opus-4-6'],
    ['haiku','claude-haiku-4-5-20251001'],
    ['best','claude-opus-4-6'],
    ['opusplan','claude-sonnet-4-6'],
    ['  My-Custom-Gateway-Deployment ','My-Custom-Gateway-Deployment'],
  ]){
    assert.equal(parseUserSpecifiedModel(input,{env}),model,input);
  }
  const overrideEnv={
    ANTHROPIC_DEFAULT_SONNET_MODEL:'sonnet-local-id',
    ANTHROPIC_DEFAULT_OPUS_MODEL:'opus-local-id',
    ANTHROPIC_DEFAULT_HAIKU_MODEL:'haiku-local-id',
  };
  assert.equal(parseUserSpecifiedModel('sonnet',{env:overrideEnv}),'sonnet-local-id');
  assert.equal(parseUserSpecifiedModel('best',{env:overrideEnv}),'opus-local-id');
  assert.equal(resolveOriginalCliModel({
    provider:'anthropic',model:'opusplan',permissionMode:'plan',env:overrideEnv,
  }),'opus-local-id');
  assert.equal(resolveOriginalCliModel({
    provider:'anthropic',model:'haiku',permissionMode:'plan',env:overrideEnv,
  }),'sonnet-local-id');
  assert.equal(getRuntimeMainLoopModel({
    permissionMode:'default',mainLoopModel:'haiku-local-id',
    userSpecifiedModel:'haiku',env:overrideEnv,
  }),'haiku-local-id');
  assert.equal(resolveOriginalCliModel({
    provider:'deepseek',model:'sonnet',env:overrideEnv,
  }),'sonnet','Never rewrite a custom DeepSeek model alias.');
  assert.equal(resolveOriginalCliModel({
    provider:'openai',model:'Opus',env:overrideEnv,
  }),'Opus','Never rewrite an OpenAI model ID.');
  for(const input of ['sonnet[1m]','opus[1M]','claude-sonnet-4-6[1m]']) {
    assert.throws(()=>parseUserSpecifiedModel(input,{env}),/\[1m\].*context-window beta/);
  }
  assert.throws(()=>parseUserSpecifiedModel('   ',{env}),/cannot be empty/);
});

async function runCli(args,env,workspace){
  let child,watchdog;
  const stdout=[],stderr=[];
  try{
    child=spawn(process.execPath,[cli,'--print','--cwd',workspace,
      '--max-retries','0',...args,'Answer the test prompt.'],{
      env:{...process.env,ANTHROPIC_API_KEY:'fixture-anthropic-key',
        DEEPSEEK_API_KEY:'fixture-deepseek-key',OPENAI_API_KEY:'fixture-openai-key',
        ...env},
      stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data',value=>stdout.push(value));
    child.stderr.on('data',value=>stderr.push(value));
    watchdog=setTimeout(()=>child.kill('SIGKILL'),25000);
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(c,s)=>resolve([c,s]));
    });
    return {code,signal,output:Buffer.concat(stdout).toString('utf8')+
      Buffer.concat(stderr).toString('utf8')};
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child?.exitCode===null)child.kill('SIGKILL');
  }
}

test('fresh packed actual CLI sends source-resolved alias/model to the live Messages API and retains provider isolation',{
  timeout:90000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-model-alias-'));
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const piece of req)chunks.push(piece);
    requests.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const base='http://127.0.0.1:'+server.address().port;
    const cases=[
      {args:['--model','sonnet'],env:{},expected:'claude-sonnet-4-6'},
      {args:['--model','OPUSPLAN','--permission-mode','plan'],
        env:{},expected:'claude-opus-4-6'},
      {args:['--model','haiku','--permission-mode','plan'],
        env:{},expected:'claude-sonnet-4-6'},
      {args:['--model','best'],
        env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'custom-opus-gateway'},
        expected:'custom-opus-gateway'},
      {args:[],env:{ANTHROPIC_MODEL:'sonnet',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'overridden-sonnet'},
        expected:'overridden-sonnet'},
      {args:['--model','MiXeD-Custom-ID'],
        env:{ANTHROPIC_MODEL:'opus'},expected:'MiXeD-Custom-ID'},
      {args:['--provider','deepseek','--model','sonnet'],
        env:{},expected:'sonnet'},
    ];
    for(const c of cases){
      const before=requests.length;
      const result=await runCli(['--base-url',base,...c.args],c.env,root);
      assert.equal(result.signal,null,result.output);
      assert.equal(result.code,0,result.output);
      assert.match(result.output,/MODEL_ALIAS_ROUND_OK/);
      assert.equal(requests.length,before+1,result.output);
      assert.equal(requests[before].body.model,c.expected,
        JSON.stringify(c));
      assert.equal(requests[before].path,'/v1/messages');
    }
    const count=requests.length;
    for(const rejected of ['sonnet[1m]','opus[1m]']){
      const result=await runCli(['--base-url',base,'--model',rejected],{},root);
      assert.equal(result.code,2,result.output);
      assert.match(result.output,/Model configuration failed:.*\[1m\]/);
      assert.equal(requests.length,count,
        'unsupported 1m context must fail before network or journal');
    }
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
});
