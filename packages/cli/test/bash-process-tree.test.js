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

test('original Bash exit boundary cannot hang on a grandchild retaining stdout and stderr', {
  timeout:25000,
},async()=>{
  await workspace(async root=>{
    const script=join(root,'foreground-exits.cjs');
    const pidFile=join(root,'orphan-candidate.pid');
    const heartbeat=join(root,'unowned-heartbeat.txt');
    await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const leaf=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('unowned-heartbeat.txt','x'),35);"
],{cwd:process.cwd(),stdio:['ignore','inherit','inherit'],windowsHide:true});
fs.writeFileSync('orphan-candidate.pid',String(leaf.pid));
process.stdout.write('foreground finished\\n');
setTimeout(()=>process.exit(0),200);
`);
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    const started=Date.now();
    const execution=bash.execute({command,timeout_ms:8000,maxOutputBytes:1024*1024});
    try {
      await waitForFile(pidFile);
      await waitForFile(heartbeat,2);
      const result=await execution;
      assert.ok(Date.now()-started<4000,
        'foreground shell exit must not block on inherited descendant pipes until 8s timeout');
      assert.equal(result.exit_code,1,
        'unregistered background tasks are fail-closed rather than reported as successful Bash');
      assert.match(result.stdout,/foreground finished/);
      assert.match(result.error,/inherited-pipe background processes|unsupported background task/);
      if(process.platform!=='win32'){
        // Unix descendants are in the actual Bash detached process group;
        // they must stop before the tool result is returned.
        const saved=await readOptional(heartbeat);
        await new Promise(resolve=>setTimeout(resolve,400));
        assert.equal(await readOptional(heartbeat),saved,
          'POSIX unowned background group must be terminated on shell exit');
      }
      // Windows CMD can exit before taskkill /T captures grandchildren.
      // The adapter returns an explicit failure, never false success; full
      // native Windows job ownership remains a separate parity task.
    } finally {
      await killIfRunning(pidFile);
      await execution.catch(()=>{});
    }
  });
});
