import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { query } from '../src/legacy-query/query.js';

function inputs(signal, checkpoint, acknowledged) {
  const taskId=randomUUID();
  const pending=[{
    taskId,
    text:'<task_notification>\n<task_id>'+taskId+
      '</task_id>\n<output_file>/private/owned.output</output_file>\n'+
      '<status>completed</status>\n<summary>Task completed</summary>\n'+
      '</task_notification>',
  }];
  let providerCalls=0;
  return {
    args:{
      messages:[{role:'user',content:'Original user prompt'}],
      signal,
      model:{stream(){
        providerCalls++;
        throw new Error('Provider must not run when checkpoint fails or run aborts.');
      }},
      tools:{describe:()=>[],get:()=>undefined},
      maxTurns:2,emit:()=>{},executeTool:async()=>{},
      getPendingTaskNotifications:()=>pending,
      onTaskNotificationsCommitted:ids=>{
        acknowledged.push(...ids);
        pending.splice(0,pending.length);
      },
      onSessionCheckpoint:checkpoint,
    },
    providerCalls:()=>providerCalls,
    queued:()=>pending.length,
    taskId,
  };
}

test('source native completion notice commits then acknowledges exactly once even when AbortSignal races after fsync',async()=>{
  const controller=new AbortController();
  const checkpointKinds=[],acknowledged=[];
  const {args,providerCalls,queued,taskId}=inputs(controller.signal,async checkpoint=>{
    checkpointKinds.push(checkpoint.kind);
    assert.equal(checkpoint.messages.at(-1).content[0].type,'text');
    controller.abort(new Error('User interrupted after native task fsync'));
  },acknowledged);
  await assert.rejects(query(args),/User interrupted after native task fsync/);
  assert.deepEqual(checkpointKinds,['task_notification']);
  assert.deepEqual(acknowledged,[taskId],
    'task notification must be acknowledged after fsync even if cancellation arrived');
  assert.equal(queued(),0);
  assert.equal(providerCalls(),0);
});

test('source native completion notice is NOT acknowledged when SessionJournal fsync fails',async()=>{
  const acknowledged=[];
  const error=new Error('Injected Session fsync failure');
  const {args,providerCalls,queued}=inputs(undefined,async checkpoint=>{
    assert.equal(checkpoint.kind,'task_notification');
    throw error;
  },acknowledged);
  await assert.rejects(query(args),e=>e===error);
  assert.deepEqual(acknowledged,[]);
  assert.equal(queued(),1,
    'failed journal commit must never consume the in-memory task notification');
  assert.equal(providerCalls(),0,
    'model is not allowed to see an uncommitted native task notification');
});
