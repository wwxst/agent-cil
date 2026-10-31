import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AnthropicMessagesAdapter} from '../src/anthropic-messages-adapter.js';
import {OpenAIChatAdapter} from '../src/openai-chat-adapter.js';

// Source 2.1.88 getMainLoopModelOverride() is evaluated per main-loop
// model request, never by restarting Query or dropping prior messages.
// Both headless transports must use the changed model ONLY on next request.
const bytes=text=>({
  async *[Symbol.asyncIterator]() {
    const buffer=Buffer.from(text,'utf8');
    for(let i=0;i<buffer.length;i+=19)
      yield buffer.subarray(i,i+19);
  },
});
const aFrame=(type,extra={})=>
  'event: '+type+'\ndata: '+JSON.stringify({type,...extra})+'\n\n';
const anthropicDone=()=>[
  aFrame('message_start',{message:{usage:{input_tokens:5}}}),
  aFrame('content_block_start',{index:0,content_block:{type:'text',text:''}}),
  aFrame('content_block_delta',{index:0,delta:{type:'text_delta',text:'ok'}}),
  aFrame('content_block_stop',{index:0}),
  aFrame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:2}}),
  aFrame('message_stop'),
].join('');
const openaiDone=()=>[
  'data: '+JSON.stringify({choices:[{index:0,delta:{content:'ok'},finish_reason:null}]})+'\n\n',
  'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n',
  'data: [DONE]\n\n',
].join('');
async function collect(adapter,messages) {
  const result=[];
  for await(const item of adapter.stream({messages,tools:[]}))result.push(item);
  return result;
}
test('original session model override updates subsequent Anthropic requests without altering history',async()=>{
  const requests=[];
  const adapter=new AnthropicMessagesAdapter({
    apiKey:'fake-local-key',model:'claude-sonnet-4-6',
    maxRetries:0,fetchImpl:async(_url,request)=>{
      requests.push(JSON.parse(request.body));
      return {ok:true,status:200,body:bytes(anthropicDone())};
    },
  });
  const history=[{role:'user',content:'original conversation remains intact'}];
  const original=structuredClone(history);
  assert.equal(adapter.model,'claude-sonnet-4-6');
  await collect(adapter,history);
  adapter.setModel('claude-opus-4-6');
  assert.equal(adapter.model,'claude-opus-4-6');
  await collect(adapter,history);
  assert.deepEqual(requests.map(r=>r.model),['claude-sonnet-4-6','claude-opus-4-6']);
  assert.deepEqual(requests[0].messages,requests[1].messages);
  assert.deepEqual(history,original);
  for(const bad of ['', ' \t ', null, undefined]) {
    assert.throws(()=>adapter.setModel(bad),TypeError);
    assert.equal(adapter.model,'claude-opus-4-6','failed update must not change model');
  }
});
test('original session override retains custom DeepSeek model IDs for Anthropic-compatible transport',async()=>{
  const requests=[];
  const adapter=new AnthropicMessagesAdapter({
    apiKey:'fake-deepseek-key',model:'deepseek-flash',
    baseUrl:'https://api.deepseek.com/anthropic',maxRetries:0,
    fetchImpl:async(_url,request)=>{
      requests.push(JSON.parse(request.body));
      return {ok:true,status:200,body:bytes(anthropicDone())};
    },
  });
  adapter.setModel('My-Custom-DeepSeek-Model');
  await collect(adapter,[{role:'user',content:'work'}]);
  assert.equal(requests[0].model,'My-Custom-DeepSeek-Model');
});
test('original session model override updates OpenAI Chat request but retains messages and credentials',async()=>{
  const requests=[];
  const adapter=new OpenAIChatAdapter({
    apiKey:'fake-local-openai-key',model:'gpt-5.1',maxRetries:0,
    fetchImpl:async(_url,request)=>{
      requests.push({
        authorization:request.headers.authorization,
        body:JSON.parse(request.body),
      });
      return {ok:true,status:200,body:bytes(openaiDone())};
    },
  });
  const history=[{role:'user',content:'preserve the task'}];
  await collect(adapter,history);
  adapter.setModel('My-Custom-OpenAI-Model');
  await collect(adapter,history);
  assert.deepEqual(requests.map(x=>x.body.model),['gpt-5.1','My-Custom-OpenAI-Model']);
  assert.deepEqual(requests.map(x=>x.body.messages),[history,history]);
  assert.equal(requests[0].authorization,requests[1].authorization);
  assert.equal(adapter.model,'My-Custom-OpenAI-Model');
});
