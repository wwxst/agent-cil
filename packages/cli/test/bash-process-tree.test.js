import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../src/index.js';

// Exercise the actual registered CLI Bash implementation, not a synthetic
// process-manager helper. Child trees must be gone before abort/timeout
// completion, even when cmd.exe/sh delegates to a grandchild.
async function workspace(fn) {
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bash-tree-'));
  try { await fn(root); }
  finally { await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
}
async function readOptional(path) {
  try {return await readFile(path,'utf8');}
  catch(error){if(error?.code==='ENOENT')return '';throw error;}
}
async function waitForFile(path,minimum=1) {
  for(let i=0;i<170;i++){
    const data=await readOptional(path);
    if(data.length>=minimum)return data;
    await new Promise(resolve=>setTimeout(resolve,35));
  }
  throw new Error('Real subprocess did not start writing its heartbeat.');
}
async function killIfRunning(path) {
  const pid=Number(await readOptional(path));
  if(Number.isSafeInteger(pid)&&pid>0) {
    try {process.kill(pid,'SIGKILL');}catch{}
  }
}
async function exerciseTree({mode}) {
  await workspace(async root=>{
    const heartbeat=join(root,'grandchild-heartbeat.txt');
    const parentPid=join(root,'launcher-pid.txt');
    const grandchildPid=join(root,'grandchild-pid.txt');
    const script=join(root,'launch.cjs');
    await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
fs.writeFileSync('launcher-pid.txt',String(process.pid));
const grandchild=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('grandchild-heartbeat.txt','x'),35);"
],{cwd:process.cwd(),stdio:'ignore',windowsHide:true});
fs.writeFileSync('grandchild-pid.txt',String(grandchild.pid));
setInterval(()=>{},1000);
`);
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    assert.ok(bash?.execute,'real CLI Bash implementation is registered');
    // cmd.exe does not interpret JSON-escaped Windows backslashes as path
    // separators. Quote exact trusted test paths without shell interpolation.
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    const controller=new AbortController();
    const execution=bash.execute({command,timeout_ms:2000},{
      signal:controller.signal,
    });
    try{
      await waitForFile(grandchildPid);
      await waitForFile(heartbeat,3);
      if(mode==='abort'){
        const error=new Error('Explicit user cancellation');
        error.name='AbortError';
        controller.abort(error);
        await assert.rejects(execution,/Explicit user cancellation/);
      }else{
        const result=await execution;
        assert.match(result.error,/timed out|killed/i);
      }
      // Completion means children have been terminated and resources
      // released, not only that the parent shell has disappeared.
      const after=await readOptional(heartbeat);
      await new Promise(resolve=>setTimeout(resolve,460));
      assert.equal(await readOptional(heartbeat),after,
        'Bash cancellation must terminate the shell descendant/grandchild tree');
    }finally {
      controller.abort();
      await killIfRunning(grandchildPid);
      await killIfRunning(parentPid);
      // Do not leave an unhandled rejection when an early assertion fails.
      await execution.catch(()=>{});
    }
  });
}

test('real registered Bash abort kills descendants on Linux and Windows', {
  timeout:25000,
},async()=>exerciseTree({mode:'abort'}));

test('real registered Bash timeout kills descendants on Linux and Windows', {
  timeout:25000,
},async()=>exerciseTree({mode:'timeout'}));
