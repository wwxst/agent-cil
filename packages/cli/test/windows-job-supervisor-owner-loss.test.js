import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForFile(path,timeoutMs=12000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    try {await stat(path);return;}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await pause(30);
  }
  throw new Error('Timed out waiting for the real Windows Bash descendant: '+path);
}
async function markerDoesNotAppear(path,waitMs) {
  await pause(waitMs);
  await assert.rejects(stat(path),{code:'ENOENT'},
    'a descendant must be terminated when its owning CLI process disappears');
}
function quoteBash(value) {
  return "'"+value.replaceAll("'","'\\''")+"'";
}
function waitForExit(child) {
  if(child.exitCode!==null || child.signalCode!==null)
    return Promise.resolve({code:child.exitCode,signal:child.signalCode});
  return new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
}

test('Windows Bash kills its Job Object when the owning CLI process exits unexpectedly',{
  skip:process.platform!=='win32' &&
    'The native Windows supervisor-owner disconnect contract requires a Windows runner',
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-winjob-owner-loss-'));
  const spawnedPath=join(root,'descendant-started.txt');
  const markerPath=join(root,'descendant-escaped.txt');
  const workerPath=join(root,'worker.mjs');
  const descendantSource=
    "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync("+
    JSON.stringify(markerPath)+",'DESCENDANT_SURVIVED'),5000);";
  const parentSource=[
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    "const child=spawn(process.execPath,['-e',"+JSON.stringify(descendantSource)+
      "],{detached:true,stdio:'ignore',windowsHide:true});",
    "child.unref();",
    "fs.writeFileSync("+JSON.stringify(spawnedPath)+",'spawned');",
    "setInterval(()=>{},1000);",
  ].join('\n');
  const command='node -e '+quoteBash(parentSource);
  const indexUrl=new URL('../src/index.js',import.meta.url).href;
  const workerSource=[
    'import {createBuiltinTools} from '+JSON.stringify(indexUrl)+';',
    'const root='+JSON.stringify(root)+';',
    'const tools=await createBuiltinTools({workspace:root,taskSession:{workspace:root,sessionId:'+
      JSON.stringify(randomUUID())+'}});',
    'await tools.get(\'Bash\').execute({command:'+JSON.stringify(command)+',timeout_ms:30000});',
  ].join('\n');
  await writeFile(workerPath,workerSource,'utf8');

  const worker=spawn(process.execPath,[workerPath],{
    cwd:root,stdio:'ignore',windowsHide:true,
  });
  try {
    await waitForFile(spawnedPath,15000);
    await assert.rejects(stat(markerPath),{code:'ENOENT'},
      'the delayed descendant must still be pending when its owner is killed');
    const exited=waitForExit(worker);
    assert.equal(worker.kill('SIGKILL'),true,
      'the test must terminate only the Node CLI owner, not its supervisor');
    const outcome=await Promise.race([
      exited,
      pause(5000).then(()=>{throw new Error('CLI owner did not exit after SIGKILL');}),
    ]);
    assert.ok(outcome.code!==null || outcome.signal!==null,
      'the owning CLI process must have exited');
    // The detached descendant is scheduled to write after 5s. The test
    // waits beyond that deadline while keeping its directory alive, so an
    // orphaned supervisor cannot pass merely because cleanup removed the file.
    await markerDoesNotAppear(markerPath,6000);
  } finally {
    if(worker.exitCode===null && worker.signalCode===null) {
      const exited=waitForExit(worker);
      try {worker.kill('SIGKILL');} catch {}
      await Promise.race([exited,pause(5000)]);
    }
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
