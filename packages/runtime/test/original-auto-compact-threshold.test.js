import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  AUTOCOMPACT_BUFFER_TOKENS,isEnvTruthy,getEffectiveContextWindowSize,
  getAutoCompactThreshold,getOriginalCliAutoCompactThreshold,
} from '../src/legacy-compact/original-auto-compact-threshold.js';
import {createAutoCompact} from '../src/legacy-compact/auto-compact.js';

test('source 2.1.88 200K context reserves 20K summary output and 13K auto-compact buffer',()=>{
  assert.equal(AUTOCOMPACT_BUFFER_TOKENS,13_000);
  for(const model of [
    'claude-sonnet-4-6','claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929','claude-opus-4-6',
    'claude-opus-4-5-20251101','claude-haiku-4-5-20251001',
  ]){
    assert.equal(getEffectiveContextWindowSize(model,{env:{}}),180_000,model);
    assert.equal(getAutoCompactThreshold(model,{env:{}}),167_000,model);
    assert.equal(getOriginalCliAutoCompactThreshold(model,{
      provider:'anthropic',env:{},
    }),167_000,model);
  }
  for(const model of [
    'unknown-custom-gateway-id','claude-sonnet-4-6[1m]',
    'deepseek-flash','gpt-5.1','',
  ]){
    assert.equal(getOriginalCliAutoCompactThreshold(model,{
      provider:'anthropic',env:{},
    }),0,'unverified window must not invent a model capability: '+model);
  }
  for(const provider of ['openai','deepseek']){
    assert.equal(getOriginalCliAutoCompactThreshold('claude-sonnet-4-6',{
      provider,env:{},
    }),0,'first-party window must not apply to '+provider);
  }
});

test('source percent/window env overrides are bounded by model window and source reserved tokens',()=>{
  const model='claude-sonnet-4-6';
  assert.equal(getAutoCompactThreshold(model,{env:{
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'0.5',
  }}),900);
  assert.equal(getAutoCompactThreshold(model,{env:{
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'100',
  }}),167_000);
  assert.equal(getAutoCompactThreshold(model,{env:{
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'invalid',
  }}),167_000);
  assert.equal(getAutoCompactThreshold(model,{env:{
    CLAUDE_CODE_AUTO_COMPACT_WINDOW:'100000',
  }}),67_000);
  assert.equal(getAutoCompactThreshold(model,{env:{
    CLAUDE_CODE_AUTO_COMPACT_WINDOW:'100000',
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:'1',
  }}),800);
  assert.equal(getAutoCompactThreshold(model,{env:{
    CLAUDE_CODE_AUTO_COMPACT_WINDOW:'30000',
  }}),0,'impossible summary window must fail closed');
  for(const truthy of ['1','TRUE','yes','on',true]){
    assert.equal(isEnvTruthy(truthy),true);
    assert.equal(getOriginalCliAutoCompactThreshold(model,{
      provider:'anthropic',env:{DISABLE_AUTO_COMPACT:truthy},
    }),0);
    assert.equal(getOriginalCliAutoCompactThreshold(model,{
      provider:'anthropic',env:{DISABLE_COMPACT:truthy},
    }),0);
  }
  for(const falsy of ['0','false','off','',undefined]){
    assert.equal(isEnvTruthy(falsy),false);
  }
});

test('source per-model threshold is reevaluated after /model without reconstructing Query',async()=>{
  const seen=[];
  const auto=createAutoCompact({thresholdTokens:model=>{
    seen.push(model);
    return getOriginalCliAutoCompactThreshold(model,{provider:'anthropic',env:{}});
  }});
  const messages=[{role:'user',content:'Keep original history.'}];
  const models=[{model:'claude-sonnet-4-6'},{model:'unknown-custom-model'},
    {model:'claude-opus-4-6'}];
  for(const model of models){
    const result=await auto.compact({messages,model});
    assert.equal(result.compacted,false);
    assert.deepEqual(result.messages,messages);
  }
  assert.deepEqual(seen,models.map(x=>x.model));
  const disabled=createAutoCompact({thresholdTokens:()=>0});
  const untouched=await disabled.compact({
    messages:[{role:'user',content:{invalid:true}}],
    model:{model:'unknown-custom-model'},
  });
  assert.equal(untouched.compacted,false,
    'source unknown window must not try to estimate unsupported model content');
});
