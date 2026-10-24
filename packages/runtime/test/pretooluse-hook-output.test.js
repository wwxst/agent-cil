import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePreToolHooks } from '../src/legacy-tools/pretooluse-node-compat.js';
import { runPreToolUseHooks } from '../src/legacy-tools/pretooluse-core.js';

async function withTemp(run) {
  const cwd=await mkdtemp(join(tmpdir(),'agent-hook-output-'));
  try {await run(cwd);} finally {await rm(cwd,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
}
test('original command Hook exit 2 blocks and never grants permission',async()=>{
  await withTemp(async cwd=>{
    await writeFile(join(cwd,'block.cjs'),"console.error('Hook rejected tool');process.exitCode=2;");
    const c={workspace:cwd,preToolUseHooks:[{
      matcher:'Write|Edit',type:'command',command:'node block.cjs',timeout:3,
    }]};
    const result=[];
    for await(const event of executePreToolHooks('Write','t1',{},c,'default',
      new AbortController().signal))result.push(event);
    assert.equal(result.length,1);
    assert.match(result[0].blockingError.blockingError,/Hook rejected tool/);
    const sourceContext={...c,abortController:new AbortController(),
      getAppState:()=>({toolPermissionContext:{mode:'default'}})};
    const source=[];
    for await(const event of runPreToolUseHooks(sourceContext,{name:'Write'}, {},'t1',
      'm1',undefined,undefined,undefined))source.push(event);
    assert.equal(source.find(e=>e.type==='hookPermissionResult').hookPermissionResult.behavior,'deny');
  });
});
test('invalid Hook JSON cannot silently produce allow',async()=>{
  await withTemp(async cwd=>{
    await writeFile(join(cwd,'invalid.cjs'),"console.log('{malformed');");
    const context={workspace:cwd,preToolUseHooks:[{matcher:'Write',type:'command',
      command:'node invalid.cjs',timeout:3}]};
    const results=[];
    for await(const x of executePreToolHooks('Write','t1',{},context,'default',
      new AbortController().signal))results.push(x);
    assert.ok(results[0].blockingError);
  });
});
test('an already aborted Hook signal cannot spawn an executing command',async()=>{
  await withTemp(async cwd=>{
    const controller=new AbortController();
    controller.abort(new Error('Cancelled before PreToolUse'));
    await assert.rejects(import('../src/legacy-tools/pretooluse-node-compat.js').then(
      ({execCommandHook})=>execCommandHook('node missing-script.cjs',{},cwd,controller.signal)
    ),/Cancelled before PreToolUse/);
  });
});
