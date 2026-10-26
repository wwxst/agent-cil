import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCommandHook } from '../src/legacy-tools/pretooluse-node-compat.js';

async function withCommand(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-cil-hook-cancel-'));
  try {
    await writeFile(join(cwd, 'slow.cjs'),
      'setTimeout(() => process.stdout.write("too-late"), 8000);');
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
test('running PreToolUse hook honors abort and cleans up without hanging', {
  timeout: 12000,
}, async () => {
  await withCommand(async cwd => {
    const controller = new AbortController();
    const started = Date.now();
    const executing = execCommandHook('node slow.cjs', {
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {},
    }, cwd, controller.signal, 9000);
    setTimeout(() => controller.abort(new Error('Stop running this hook')), 200);
    await assert.rejects(executing, /Stop running this hook/);
    assert.ok(Date.now() - started < 5000, 'active Hook abort must release subprocess handles');
  });
});
test('running PreToolUse hook honors timeout without waiting for command completion', {
  timeout: 12000,
}, async () => {
  await withCommand(async cwd => {
    const started = Date.now();
    await assert.rejects(execCommandHook('node slow.cjs', {
      hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {},
    }, cwd, new AbortController().signal, 350), /timed out/);
    assert.ok(Date.now() - started < 5000, 'timeout must not leave Hook process running');
  });
});


async function readIfExists(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

test('real Hook abort and timeout terminate inherited-pipe grandchildren, not just the shell', {
  timeout: 24000,
}, async () => {
  for (const mode of ['abort', 'timeout']) {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-cil-hook-tree-' + mode + '-'));
    const heartbeat = join(cwd, 'grandchild-heartbeat.txt');
    const pidFile = join(cwd, 'grandchild-pid.txt');
    let controller, executing;
    try {
      const grandchildSource =
        "const fs=require('node:fs');"+
        "setInterval(()=>fs.appendFileSync('grandchild-heartbeat.txt','x'),30);";
      await writeFile(join(cwd,'tree.cjs'), [
        "const fs=require('node:fs');",
        "const {spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e',"+JSON.stringify(grandchildSource)+
          "],{stdio:'inherit',cwd:process.cwd(),windowsHide:true});",
        "fs.writeFileSync('grandchild-pid.txt',String(child.pid));",
        "setInterval(()=>{},200);",
      ].join('\n'));
      controller = new AbortController();
      executing = execCommandHook('node tree.cjs', {
        hook_event_name: 'PreToolUse', tool_name:'Write', tool_input:{},
      }, cwd, controller.signal, mode==='abort'?9500:1800);
      // Attach a rejection observer before the I/O poll in case the process
      // fails before a grandchild ever writes its first heartbeat.
      void executing.catch(()=>{});
      let started=false;
      for (let i=0;i<160;i++) {
        if ((await readIfExists(heartbeat)).length >= 3) {
          started=true;
          break;
        }
        await new Promise(resolve=>setTimeout(resolve,30));
      }
      assert.equal(started,true,'actual Hook grandchild must run before cancellation');
      if (mode==='abort') {
        controller.abort(new Error('Cancel real Hook tree'));
        await assert.rejects(executing,/Cancel real Hook tree/);
      } else {
        await assert.rejects(executing,/Hook command timed out/);
      }
      const captured=await readIfExists(heartbeat);
      await new Promise(resolve=>setTimeout(resolve,430));
      assert.equal(await readIfExists(heartbeat),captured,
        'original Hook cancellation must reap inherited-pipe grandchild before returning');
    } finally {
      controller?.abort();
      await executing?.catch(()=>{});
      const pid=Number(await readIfExists(pidFile));
      if(Number.isSafeInteger(pid)&&pid>0) {
        try{process.kill(pid,'SIGKILL');}catch{}
      }
      await rm(cwd,{recursive:true,force:true,maxRetries:8,retryDelay:125});
    }
  }
});
