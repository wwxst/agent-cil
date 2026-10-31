import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBuiltinTools,cleanupLiveShellCommands,getShellLifecycleStatus}
  from '../src/index.js';

test('cold native Windows Bash startup establishes its Job Object owner before returning',{
  skip:process.platform!=='win32' &&
    'The native Windows Job Object handshake contract requires a Windows runner',
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-winjob-smoke-'));
  const sessionId=randomUUID();
  let diagnosticTimer;
  try {
    console.error('[windows-smoke] creating builtin tools');
    const tools=await createBuiltinTools({
      workspace:root,taskSession:{workspace:root,sessionId},
    });
    console.error('[windows-smoke] builtin tools ready; invoking Bash');
    diagnosticTimer=setTimeout(async()=>{
      try {
        const names=await readdir(tmpdir());
        const stages=names.filter(name=>name.startsWith('agent-cil-winjob-') &&
          (name.endsWith('.stage') || name.endsWith('.stage.node')));
        const details=await Promise.all(stages.map(async name=>({
          name,content:(await readFile(join(tmpdir(),name),'utf8')).slice(-12000),
        })));
        console.error('[windows-smoke] 15s diagnostic',JSON.stringify(details));
      } catch(error) {
        console.error('[windows-smoke] diagnostic failed',String(error));
      }
    },15000);
    const result=await tools.get('Bash').execute({
      command:'echo AGENT_CIL_WINDOWS_JOB_OBJECT_READY',
      timeout_ms:30000,
    });
    clearTimeout(diagnosticTimer);
    diagnosticTimer=null;
    console.error('[windows-smoke] Bash returned',JSON.stringify({
      exit_code:result.exit_code,error:result.error,stdout:result.stdout,stderr:result.stderr,
    }));
    assert.equal(result.exit_code,0,result.error);
    assert.equal(result.error,undefined,
      `A command that reaches its timeout/kill path is not a successful startup preflight; exit_code=${result.exit_code}; stdout=${JSON.stringify(result.stdout)}; stderr=${JSON.stringify(result.stderr)}; error=${String(result.error)}`);
    assert.match(result.stdout,/AGENT_CIL_WINDOWS_JOB_OBJECT_READY/);
    const envResult=await tools.get('Bash').execute({
      command:'node -e "process.stdout.write(Object.keys(process.env).filter(k=>/^AGENT_CIL_.*_COMMAND$/.test(k)).join(\',\'))"',
      timeout_ms:30000,
    });
    assert.equal(envResult.exit_code,0,envResult.error);
    assert.equal(envResult.stdout,'',
      'the private Windows supervisor command source must not leak into child environments');
    assert.deepEqual(getShellLifecycleStatus(),{
      liveShellCommands:0,pendingKillBackstops:0,
    });
  } finally {
    clearTimeout(diagnosticTimer);
    await cleanupLiveShellCommands().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
