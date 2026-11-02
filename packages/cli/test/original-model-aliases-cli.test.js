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
  getRuntimeMainLoopModel,resolveOriginalCliModel,getDefaultFableModel,
  getModelContextWindow,getModelMaxOutputTokens,isModelAllowed,resolveModelRequest,
  getModelMetadata,isModelFamilyAlias,modelSupports1M,
  getDefaultSonnetModel,getDefaultOpusModel,getDefaultHaikuModel,
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
test('2.1.304 model catalog preserves aliases, custom casing, native 1M and plan adjustments',()=>{
  assert.deepEqual(MODEL_ALIASES,[
    'sonnet','opus','haiku','fable','best','sonnet[1m]','opus[1m]','fable[1m]','opusplan',
  ]);
  assert.equal(isModelAlias('sonnet'),true);
  assert.equal(isModelAlias('Sonnet'),false);
  assert.equal(isModelAlias('fable'),true);
  assert.equal(isModelAlias('fable[1m]'),true);
  assert.equal(isModelFamilyAlias('fable'),true);
  const env={};
  for(const [input,model] of [
    ['sonnet','claude-sonnet-5-5'],
    [' SONNET ','claude-sonnet-5-5'],
    ['opus','claude-opus-5-5'],
    ['haiku','claude-haiku-5-5'],
    ['best','claude-fable-5-1'],
    ['fable','claude-fable-5-1'],
    ['opusplan','claude-sonnet-5-5'],
    ['  My-Custom-Gateway-Deployment ','My-Custom-Gateway-Deployment'],
  ]){
    assert.equal(parseUserSpecifiedModel(input,{env}),model,input);
  }
  const overrideEnv={
    ANTHROPIC_DEFAULT_SONNET_MODEL:'sonnet-local-id',
    ANTHROPIC_DEFAULT_OPUS_MODEL:'opus-local-id',
    ANTHROPIC_DEFAULT_HAIKU_MODEL:'haiku-local-id',
    ANTHROPIC_DEFAULT_FABLE_MODEL:'fable-local-id',
  };
  assert.equal(parseUserSpecifiedModel('sonnet',{env:overrideEnv}),'sonnet-local-id');
  assert.equal(parseUserSpecifiedModel('best',{env:overrideEnv}),'fable-local-id');
  assert.equal(getDefaultFableModel(overrideEnv),'fable-local-id');
  assert.equal(getDefaultSonnetModel({}, {apiProvider:'bedrock'}),'claude-sonnet-4-5');
  assert.equal(getDefaultOpusModel({}, {apiProvider:'gateway'}),'claude-opus-4-7');
  assert.equal(getDefaultHaikuModel({}, {apiProvider:'anthropicGoogleCloud'}),'claude-haiku-4-5');
  assert.equal(getDefaultFableModel({}, {apiProvider:'gateway'}),'claude-fable-5');
  assert.equal(parseUserSpecifiedModel('best',{env,availableModels:['opus']}),
    'claude-opus-5-5',
    'best falls back to Opus when Fable is excluded by the model allowlist');
  assert.equal(parseUserSpecifiedModel('best',{env,deniedModels:['fable']}),
    'claude-opus-5-5',
    'best falls back to Opus when Fable is explicitly denied');
  assert.equal(isModelAllowed('best',{availableModels:['best']}),true,
    'the best alias can appear in an allowlist without recursive resolution');
  assert.equal(isModelAllowed('claude-fable-5-1',{availableModels:['best']}),true,
    'the best alias resolves to the selected Fable catalog model');
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
  assert.equal(parseUserSpecifiedModel('sonnet[1m]',{env}),'claude-sonnet-5-5[1m]',
    '2.1.304 retains the explicit 1M attribute for family aliases');
  assert.equal(parseUserSpecifiedModel('sonnet[1m]',{env:overrideEnv}),'sonnet-local-id[1m]',
    'non-native custom defaults retain the explicit 1M opt-in');
  assert.equal(resolveOriginalCliModel({
    provider:'anthropic',model:'opusplan[1m]',permissionMode:'plan',env:overrideEnv,
  }),'opus-local-id[1m]',
  'opusplan[1m] upgrades to the Opus family and preserves beta opt-in for custom models');
  assert.equal(parseUserSpecifiedModel('claude-sonnet-4-6[1m]',{env}),'claude-sonnet-4-6[1m]');
  assert.equal(parseUserSpecifiedModel('claude-sonnet-5-5[1m]',{env}),'claude-sonnet-5-5',
    'native 1M model IDs do not need the suffix on the first-party API');
  assert.equal(parseUserSpecifiedModel('claude-sonnet-5-5[1m]',{
    env,firstPartyBaseUrl:false,
  }),'claude-sonnet-5-5[1m]',
  'custom API base URLs retain explicit 1M model attributes');
  assert.equal(parseUserSpecifiedModel('fable[1m]',{env}),'claude-fable-5-1');
  assert.equal(parseUserSpecifiedModel('fable[1m]',{
    env,firstPartyBaseUrl:false,
  }),'claude-fable-5-1[1m]');
  assert.deepEqual(resolveModelRequest('claude-sonnet-5-5[1m]'),{
    model:'claude-sonnet-5-5',betaHeaders:[],
  },'native 1M models do not send the context beta');
  assert.deepEqual(resolveModelRequest('claude-sonnet-4-6[1m]'),{
    model:'claude-sonnet-4-6',betaHeaders:['context-1m-2025-08-07'],
  });
  assert.deepEqual(resolveModelRequest('claude-haiku-4-5[1m]'),{
    model:'claude-haiku-4-5-20251001',betaHeaders:[],
  },'supports_1m_suffix is distinct from supports_1m_beta in the source catalog');
  assert.deepEqual(resolveModelRequest('claude-sonnet-5-5[1m]',{
    env:{CLAUDE_CODE_DISABLE_1M_CONTEXT:'1'},
  }),{model:'claude-sonnet-5-5',betaHeaders:[]},
  'the disable flag suppresses 1M negotiation instead of rejecting the model setting');
  assert.throws(()=>resolveModelRequest('claude-sonnet-5-5[1m]',{
    provider:'deepseek',
  }),/only by the Anthropic provider/);
  assert.equal(getModelContextWindow('claude-sonnet-5-5'),1_000_000);
  assert.equal(getModelContextWindow('claude-sonnet-4-6'),200_000);
  assert.equal(getModelContextWindow('claude-sonnet-4-6[1m]'),1_000_000);
  assert.equal(getModelContextWindow('claude-sonnet-5-5[1m]',{
    env:{CLAUDE_CODE_DISABLE_1M_CONTEXT:'1'},
  }),200_000);
  assert.equal(modelSupports1M('claude-haiku-4-5-20251001'),true);
  assert.equal(getModelMetadata('us.anthropic.claude-sonnet-4-6').id,
    'claude-sonnet-4-6','all provider IDs map back to the baked catalog row');
  assert.deepEqual(getModelMaxOutputTokens('claude-sonnet-5-5'),{
    default:128_000,upperLimit:128_000,
  });
  assert.equal(isModelAllowed('claude-opus-5-5',{availableModels:['opus']}),true);
  assert.equal(isModelAllowed('claude-opus-4-6',{
    availableModels:['opus','opus-5-5'],
  }),false,'a version-qualified entry narrows the family wildcard');
  assert.equal(isModelAllowed('claude-opus-5-5',{
    availableModels:['opus','opus-5-5'],
  }),true);
  assert.equal(isModelAllowed('claude-sonnet-5-5',{availableModels:[]}),false);
  assert.equal(isModelAllowed('claude-sonnet-5-5',{deniedModels:['sonnet']}),false);
  assert.equal(isModelAllowed('claude-opus-5-5',{deniedModels:['opus-5-5']}),false);
  assert.equal(isModelAllowed('claude-opus-4-6',{deniedModels:['opus-5-5']}),true,
    'a versioned deniedModels entry blocks only that major/minor family version');
  assert.equal(isModelAllowed('my-custom',{deniedModels:['my-custom']}),false,
    'unknown denied model entries are exact literals');
  assert.equal(isModelAllowed('my-custom-model',{deniedModels:['my-custom']}),true,
    'unknown denied literals do not become accidental prefix rules');
  assert.equal(isModelAllowed('claude-fable-5-1',{deniedModels:['best']}),true,
    'dynamic aliases are ignored in deniedModels, as in 2.1.304');
  assert.equal(isModelAllowed('claude-opus-5-5',{deniedModels:['default']}),true,
    'the default alias is ignored in deniedModels');
  assert.equal(resolveOriginalCliModel({
    provider:'anthropic',model:'opus',availableModels:['sonnet'],env,
  }),'claude-sonnet-5-5','a disallowed saved selection falls back to the permitted default');
  assert.equal(resolveOriginalCliModel({
    provider:'anthropic',model:'sonnet',availableModels:['opus-4-6'],env,
  }),'claude-opus-4-6',
  'a version-only allowlist entry resolves to its canonical first-party model ID');
  assert.equal(getRuntimeMainLoopModel({
    permissionMode:'plan',mainLoopModel:'claude-sonnet-5-5',
    userSpecifiedModel:'opusplan',availableModels:['sonnet'],env,
  }),'claude-sonnet-5-5','plan-mode upgrades cannot escape the allowlist');
  assert.equal(getRuntimeMainLoopModel({
    permissionMode:'plan',mainLoopModel:'claude-sonnet-5-5',
    userSpecifiedModel:'opusplan',
    availableModels:['sonnet','opus-4-6'],env,
  }),'claude-opus-4-6',
  'plan mode steps down to the newest permitted model in the requested family');
  assert.equal(getRuntimeMainLoopModel({
    permissionMode:'plan',mainLoopModel:'claude-sonnet-5-5[1m]',
    userSpecifiedModel:'opusplan[1m]',
    availableModels:['sonnet','opus-4-6'],env,
  }),'claude-opus-4-6[1m]',
  '1M plan upgrades preserve the suffix when stepping down to a suffix-capable model');
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
    requests.push({path:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream());
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const base='http://127.0.0.1:'+server.address().port;
    const cases=[
      {args:['--model','sonnet'],env:{},expected:'claude-sonnet-5-5'},
      {args:['--model','OPUSPLAN','--permission-mode','plan'],
        env:{},expected:'claude-opus-5-5'},
      {args:['--model','haiku','--permission-mode','plan'],
        env:{},expected:'claude-sonnet-5-5'},
      {args:['--model','best'],
        env:{ANTHROPIC_DEFAULT_FABLE_MODEL:'custom-fable-gateway'},
        expected:'custom-fable-gateway'},
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
    const nativeOneM=await runCli([
      '--base-url',base,'--model','sonnet[1m]',
    ],{},root);
    assert.equal(nativeOneM.code,0,nativeOneM.output);
    assert.equal(requests.at(-1).body.model,'claude-sonnet-5-5');
    assert.equal(requests.at(-1).headers['anthropic-beta'],undefined,
      'native 1M model must not request the beta');

    const betaOneM=await runCli([
      '--base-url',base,'--model','claude-sonnet-4-6[1m]',
    ],{},root);
    assert.equal(betaOneM.code,0,betaOneM.output);
    assert.equal(requests.at(-1).body.model,'claude-sonnet-4-6');
    assert.match(requests.at(-1).headers['anthropic-beta']??'',
      /context-1m-2025-08-07/);

    const count=requests.length;
    const rejected=await runCli([
      '--base-url',base,'--model','claude-haiku-4-5[1m]',
    ],{},root);
    assert.equal(rejected.code,2,rejected.output);
    assert.match(rejected.output,/Model configuration failed:.*1M context beta/);
    assert.equal(requests.length,count,
      'unsupported 1M model must fail before network or journal');
  }finally{
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  }
});
