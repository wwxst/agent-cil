import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeHookAttachmentForAPI,
  normalizeToolHookAttachmentsForAPI,
  wrapInSystemReminder,
} from '../src/legacy-query/normalize-hook-attachments.js';

const event=(toolUseId,attachment,turn=1)=>({
  turn,toolUseId,message:{type:'attachment',attachment},
});
test('source 2.1.88 normalizes PostToolUse additionalContext as system-reminder meta user text',()=>{
  const block=normalizeHookAttachmentForAPI({type:'attachment',attachment:{
    type:'hook_additional_context',hookName:'PostToolUse:Write',
    content:['one','two'],
  }});
  assert.deepEqual(block,[{type:'text',
    text:wrapInSystemReminder('PostToolUse:Write hook additional context: one\ntwo'),
  }]);
});
test('source hook API mapping drops display-only errors and success without losing direct events',()=>{
  for(const type of ['hook_success','hook_cancelled','hook_error_during_execution',
    'hook_non_blocking_error','hook_system_message','hook_permission_decision']) {
    assert.deepEqual(normalizeHookAttachmentForAPI({
      type:'attachment',attachment:{type,hookName:'PostToolUse:Write'},
    }),[]);
  }
});
test('source hook API mapping preserves blocking error and stopped continuation messages',()=>{
  const blocking=normalizeHookAttachmentForAPI({type:'attachment',attachment:{
    type:'hook_blocking_error',hookName:'PostToolUse:Write',
    blockingError:{command:'node verify.cjs',blockingError:'verification failed'},
  }});
  assert.match(blocking[0].text,/verification failed/);
  assert.match(blocking[0].text,/node verify.cjs/);
  const stop=normalizeHookAttachmentForAPI({type:'attachment',attachment:{
    type:'hook_stopped_continuation',hookName:'PostToolUse:Write',message:'Stop now',
  }});
  assert.match(stop[0].text,/hook stopped continuation: Stop now/);
});
test('source Query attachment normalization uses tool_use order, not concurrent Hook completion order',()=>{
  const events=[
    event('second',{type:'hook_additional_context',hookName:'PostToolUse:Edit',content:['second']} ),
    event('first',{type:'hook_additional_context',hookName:'PostToolUse:Write',content:['first']} ),
    event('first',{type:'hook_non_blocking_error',hookName:'PostToolUse:Write'}),
    event('first',{type:'hook_additional_context',hookName:'PostToolUse:Write',content:['previous turn']},0),
    event('orphan',{type:'hook_additional_context',hookName:'PostToolUse:Unknown',content:['orphan']}),
  ];
  const got=normalizeToolHookAttachmentsForAPI(events,[{id:'first'},{id:'second'}],1);
  assert.equal(got.length,2);
  assert.match(got[0].text,/first/);
  assert.match(got[1].text,/second/);
  assert.doesNotMatch(got.map(b=>b.text).join(' '),/orphan|previous turn/);
});
test('source conversion rejects structurally invalid context, unknown hook attachment and bad stop payload',()=>{
  assert.throws(()=>normalizeHookAttachmentForAPI({
    type:'attachment',attachment:{type:'hook_additional_context',content:'bad'},
  }),/Malformed Hook additional context/);
  assert.throws(()=>normalizeHookAttachmentForAPI({
    type:'attachment',attachment:{type:'hook_future_unported'},
  }),/Unsupported Hook attachment/);
  assert.throws(()=>normalizeHookAttachmentForAPI({
    type:'attachment',attachment:{type:'hook_stopped_continuation'},
  }),/Malformed Hook stop message/);
});
