import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools, cleanupLiveShellCommands, getShellLifecycleStatus } from '../src/index.js';

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
async function killTreeIfRunning(path) {
  const pid=Number(await readOptional(path));
  if(!Number.isSafeInteger(pid)||pid<=1)return;
  if(process.platform==='win32'){
    // Test-only cleanup: taskkill is NOT intercepted in this test process.
    // After the intentionally failed CLI taskkill, wait for the real OS
    // termination worker before releasing the temporary workspace.
    await new Promise(resolve=>{
      const systemRoot=process.env.SystemRoot || 'C:\\Windows';
      const killer=spawn(join(systemRoot,'System32','taskkill.exe'),
        ['/PID',String(pid),'/T','/F'],
        {windowsHide:true,stdio:'ignore',shell:false});
      killer.once('error',()=>resolve());
      killer.once('close',()=>resolve());
    });
  }
  try{process.kill(pid,'SIGKILL');}catch{}
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



test('real Bash cancellation kills a detached grandchild on Linux and Windows', {
  timeout: 24000,
}, async()=>{
  await workspace(async root=>{
    const script=join(root,'escape-pgid.cjs');
    const heartbeat=join(root,'escaped-heartbeat.txt');
    const pidFile=join(root,'escaped-leaf.pid');
    await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const grandchild=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('escaped-heartbeat.txt','x'),30);"
],{cwd:process.cwd(),detached:true,stdio:'ignore',windowsHide:true});
fs.writeFileSync('escaped-leaf.pid',String(grandchild.pid));
setInterval(()=>{},500);
`);
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    const controller=new AbortController();
    const execution=bash.execute({command,timeout_ms:12000},{
      signal:controller.signal,
    });
    try {
      await waitForFile(pidFile);
      await waitForFile(heartbeat,3);
      const previous=await readOptional(heartbeat);
      assert.ok(previous.length>0);
      controller.abort(new Error('Abort Bash with detached descendant'));
      await assert.rejects(execution,/Abort Bash with detached descendant/);
      const after=await readOptional(heartbeat);
      await new Promise(resolve=>setTimeout(resolve,500));
      assert.equal(await readOptional(heartbeat),after,
        'a detached grandson has a DIFFERENT POSIX process group but must be terminated');
      assert.deepEqual(getShellLifecycleStatus(),{
        liveShellCommands:0,pendingKillBackstops:0,
      });
    } finally {
      controller.abort();
      await killIfRunning(pidFile);
      await execution.catch(()=>{});
    }
  });
});

test('source liveShellCommands and pendingKillBackstops reap two concurrent Bash trees before cleanup completes', {
  timeout:30000,
},async()=>{
  await workspace(async root=>{
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    const executions=[], pidFiles=[],heartbeatFiles=[];
    try {
      for(const index of [1,2]){
        const script=join(root,'owned-'+index+'.cjs');
        const pidFile=join(root,'owned-'+index+'.pid');
        const heartbeat=join(root,'owned-'+index+'.txt');
        pidFiles.push(pidFile);
        heartbeatFiles.push(heartbeat);
        await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const leaf=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('owned-${index}.txt','x'),35);"
],{cwd:process.cwd(),stdio:'ignore',windowsHide:true});
fs.writeFileSync('owned-${index}.pid',String(leaf.pid));
setInterval(()=>{},500);
`);
        const command='"'+process.execPath.replaceAll('"','')+'" "'+
          script.replaceAll('"','')+'"';
        executions.push(bash.execute({command,timeout_ms:11000}));
      }
      await Promise.all(heartbeatFiles.map(file=>waitForFile(file,3)));
      assert.equal(getShellLifecycleStatus().liveShellCommands,2,
        'the same original-style registry must own BOTH live commands');
      await cleanupLiveShellCommands();
      const outputs=await Promise.all(executions);
      for(const result of outputs){
        assert.equal(result.exit_code,1);
        assert.match(result.error,/terminated while releasing its owning CLI session/);
      }
      const after=await Promise.all(heartbeatFiles.map(readOptional));
      await new Promise(resolve=>setTimeout(resolve,450));
      assert.deepEqual(await Promise.all(heartbeatFiles.map(readOptional)),after,
        'awaited process-tree shutdown must stop both grandchild side effects');
      assert.deepEqual(getShellLifecycleStatus(),{
        liveShellCommands:0,pendingKillBackstops:0,
      });
      await cleanupLiveShellCommands();
      assert.deepEqual(getShellLifecycleStatus(),{
        liveShellCommands:0,pendingKillBackstops:0,
      },'repeated global cleanup is idempotent');
    }finally {
      await cleanupLiveShellCommands();
      for(const file of pidFiles)await killIfRunning(file);
      await Promise.allSettled(executions);
    }
  });
});


test('Windows taskkill launch failure is reported, never mistaken for a completed Bash subtree cleanup', {
  skip:process.platform!=='win32' &&
    'SystemRoot/System32 taskkill.exe validation requires the real Windows process API',
  timeout:30000,
},async()=>{
  for(const mode of ['abort','owner-shutdown']) {
    await workspace(async root=>{
      const script=join(root,'unavailable-taskkill-'+mode+'.cjs');
      const pidFile=join(root,'unreaped-'+mode+'.pid');
      const launcherPidFile=join(root,'unreaped-'+mode+'-launcher.pid');
      const beatFile=join(root,'unreaped-'+mode+'.txt');
      await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
fs.writeFileSync('unreaped-${mode}-launcher.pid',String(process.pid));
const child=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('unreaped-${mode}.txt','x'),35);"
],{cwd:process.cwd(),windowsHide:true,stdio:'ignore'});
fs.writeFileSync('unreaped-${mode}.pid',String(child.pid));
setInterval(()=>{},500);
`);
      const cmd='"'+process.execPath.replaceAll('"','')+'" "'+
        script.replaceAll('"','')+'"';
      const bash=(await createBuiltinTools({workspace:root})).get('Bash');
      const controller=new AbortController();
      const execution=bash.execute({command:cmd,timeout_ms:12000},{
        signal:controller.signal,
      });
      const oldRoot=process.env.SystemRoot;
      try {
        await waitForFile(pidFile);
        await waitForFile(beatFile,3);
        // Force the same taskkill.exe ENOENT condition that occurs on a
        // damaged Windows environment. This must NEVER count as cleaning
        // the whole process tree. The already-created child may survive.
        process.env.SystemRoot=join(root,'unavailable-SystemRoot');
        if(mode==='abort') {
          controller.abort(new Error('cancel the real Bash subtree'));
          await assert.rejects(execution,error=>
            error?.name==='ProcessTreeCleanupError' &&
            /Windows Bash process-tree cleanup could not be confirmed/.test(error.message));
        }else {
          await assert.rejects(cleanupLiveShellCommands(),error=>
            error instanceof AggregateError && error.errors.some(reason=>
              reason?.name==='ProcessTreeCleanupError'));
          await assert.rejects(execution,error=>
            error?.name==='ProcessTreeCleanupError' &&
            /process-tree cleanup could not be confirmed/.test(error.message));
        }
        assert.deepEqual(getShellLifecycleStatus(),{
          liveShellCommands:0,pendingKillBackstops:0,
        });
      }finally {
        if(oldRoot===undefined)delete process.env.SystemRoot;
        else process.env.SystemRoot=oldRoot;
        controller.abort();
        await killIfRunning(pidFile);
        await killIfRunning(launcherPidFile);
        await execution.catch(()=>{});
      }
    });
  }
});

test('original Bash exit boundary cannot hang on a grandchild retaining stdout and stderr', {
  // CMD does not guarantee inherited-pipe handles remain open after it
  // exits. A successful close there cannot prove that grandchildren died.
  // Windows process ownership requires the still-unported native task
  // registry / Job Object; do not pretend the POSIX process-group guard
  // provides that OS-specific guarantee.
  skip:process.platform==='win32' &&
    'Windows shell close does not prove descendant lifecycle; Job ownership remains unported',
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



test('2.1.304 leftRunningPgid check reaps Bash background descendant with closed stdio', {
  skip:process.platform==='win32' &&
    'POSIX process-group existence check; Windows Job ownership is not yet available',
  timeout:18000,
},async()=>{
  await workspace(async root=>{
    const script=join(root,'stdio-closed-launcher.cjs');
    const heartbeat=join(root,'closed-stdio-heartbeat.txt');
    const childPid=join(root,'closed-stdio-grandchild.pid');
    await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const leaf=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('closed-stdio-heartbeat.txt','x'),35);"
],{cwd:process.cwd(),stdio:'ignore'});
fs.writeFileSync('closed-stdio-grandchild.pid',String(leaf.pid));
process.stdout.write('foreground output survives\\n');
setTimeout(()=>process.exit(0),180);
`);
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    const execution=bash.execute({command,timeout_ms:8000});
    try{
      await waitForFile(childPid);
      await waitForFile(heartbeat,2);
      const started=Date.now();
      const result=await execution;
      assert.ok(Date.now()-started<3000,
        'a shell may exit with stdio already closed while grandchildren still run');
      assert.equal(result.exit_code,1);
      assert.match(result.error,/unsupported background task was terminated/);
      assert.match(result.stdout,/foreground output survives/);
      const after=await readOptional(heartbeat);
      await new Promise(resolve=>setTimeout(resolve,430));
      assert.equal(await readOptional(heartbeat),after,
        'orphaned background task with closed pipes must not keep writing');
    }finally {
      await killIfRunning(childPid);
      await execution.catch(()=>{});
    }
  });
});

function sseFrame(type,data={}) {
  return 'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
}
function sseBashUse(command, timeoutMs=11000) {
  return sseFrame('message_start',{message:{usage:{input_tokens:20}}})+
    sseFrame('content_block_start',{index:0,content_block:{
      type:'tool_use',id:'exit-with-unowned-grandchild',name:'Bash',input:{},
    }})+
    sseFrame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify({
        command,timeout_ms:timeoutMs,
      }),
    }})+
    sseFrame('content_block_stop',{index:0})+
    sseFrame('message_delta',{delta:{stop_reason:'tool_use'},usage:{output_tokens:12}})+
    sseFrame('message_stop');
}
function sseFinal() {
  return sseFrame('message_start',{message:{usage:{input_tokens:30}}})+
    sseFrame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    sseFrame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'Handled unsupported background process safely',
    }})+
    sseFrame('content_block_stop',{index:0})+
    sseFrame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:15}})+
    sseFrame('message_stop');
}

test('real packed-capable CLI carries early shell-exit result and stderr to next model round', {
  // Only POSIX detached process-group semantics can currently prove the
  // background descendant is gone. Windows Job ownership is not yet ported.
  skip:process.platform==='win32' &&
    'Windows Job ownership remains unported; process inherited pipe closes are not reliable',
  timeout:30000,
},async()=>{
  await workspace(async root=>{
    const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
      fileURLToPath(new URL('../src/index.js',import.meta.url));
    const script=join(root,'cli-exits.cjs');
    const pidFile=join(root,'cli-unowned.pid');
    const heartbeat=join(root,'cli-unowned-heartbeat.txt');
    const command='node cli-exits.cjs';
    const requests=[];
    const server=createServer(async(req,res)=>{
      const chunks=[];for await(const b of req)chunks.push(b);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(requests.length===1?sseBashUse(command):sseFinal());
    });
    let child,closed,watchdog;
    try {
      await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const leaf=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('cli-unowned-heartbeat.txt','x'),35);"
],{cwd:process.cwd(),stdio:['ignore','inherit','inherit']});
fs.writeFileSync('cli-unowned.pid',String(leaf.pid));
process.stdout.write('original foreground output\\n');
process.stderr.write('original foreground stderr\\n');
setTimeout(()=>process.exit(0),180);
`);
      await new Promise((resolve,reject)=>{
        server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
      });
      const started=Date.now();
      child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
        '--cwd',root,'--max-retries','0','--max-turns','3',
        '--compact-threshold','0',
        '--allowedTools','Bash('+command+')',
        '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
        'Run one Bash command and explain the result'],{
        env:{...process.env,DEEPSEEK_API_KEY:'local-unowned-fixture'},
        stdio:['ignore','pipe','pipe'],
      });
      const out=[],err=[];
      child.stdout.on('data',b=>out.push(b));
      child.stderr.on('data',b=>err.push(b));
      closed=new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('close',(code,signal)=>resolve({code,signal}));
      });
      watchdog=setTimeout(()=>child.kill('SIGKILL'),14500);
      const result=await closed;
      const stdout=Buffer.concat(out).toString('utf8');
      const stderr=Buffer.concat(err).toString('utf8');
      assert.equal(result.signal,null,stderr);
      assert.equal(result.code,0,stdout+stderr);
      assert.ok(Date.now()-started<7000,'must not wait for the 11s Bash timeout');
      assert.match(stdout,/Handled unsupported background process safely/);
      assert.equal(requests.length,2);
      const providerBody=JSON.stringify(requests[1].messages);
      assert.match(providerBody,/unsupported background task was terminated/);
      assert.match(providerBody,/original foreground output/);
      assert.match(providerBody,/original foreground stderr/);
      const saved=await readOptional(heartbeat);
      assert.ok(saved.length>0,'the grandchild must have executed before kill');
      await new Promise(resolve=>setTimeout(resolve,430));
      assert.equal(await readOptional(heartbeat),saved,
        'unowned side effects must be stopped before the model turn advances');
    } finally {
      if(watchdog)clearTimeout(watchdog);
      if(child&&child.exitCode===null)child.kill('SIGKILL');
      if(closed)await closed.catch(()=>{});
      await killTreeIfRunning(launcherPidFile);
      await killTreeIfRunning(pidFile);
      if(process.platform==='win32')
        await new Promise(resolve=>setTimeout(resolve,300));
      server.closeAllConnections?.();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    }
  });
});


test('Windows real CLI stops before second model request when taskkill fails after a side-effecting Bash', {
  skip:process.platform!=='win32' &&
    'SystemRoot/System32 taskkill failure is a Windows-only OS cleanup path',
  timeout:38000,
},async()=>{
  await workspace(async root=>{
    const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
      fileURLToPath(new URL('../src/index.js',import.meta.url));
    const sessionId=randomUUID();
    const command='node unconfirmed-children.cjs';
    const script=join(root,'unconfirmed-children.cjs');
    const pidFile=join(root,'unconfirmed-children.pid');
    const launcherPidFile=join(root,'unconfirmed-launcher.pid');
    const beatFile=join(root,'unconfirmed-children.txt');
    const requests=[];
    const server=createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(requests.length===1?sseBashUse(command,1250):sseFinal());
    });
    let child,closed,watchdog;
    try {
      await writeFile(script,`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
fs.writeFileSync('unconfirmed-launcher.pid',String(process.pid));
const leaf=spawn(process.execPath,['-e',
  "const fs=require('node:fs');"+
  "setInterval(()=>fs.appendFileSync('unconfirmed-children.txt','x'),35);"
],{cwd:process.cwd(),stdio:'ignore',windowsHide:true});
fs.writeFileSync('unconfirmed-children.pid',String(leaf.pid));
setInterval(()=>{},500);
`);
      await new Promise((resolve,reject)=>{
        server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
      });
      // Test-only preloader intercepts ONLY the OS taskkill executable
      // and simulates ENOENT. Do not corrupt SystemRoot: Node's Windows
      // CSPRNG can fail during initialization with a fake SystemRoot.
      const taskkillFailurePreload=join(root,'inject-taskkill-failure.cjs');
      await writeFile(taskkillFailurePreload,[
        "const cp=require('node:child_process');",
        "const events=require('node:events');",
        "const original=cp.spawn;",
        "cp.spawn=function(binary,args,options){",
        " if(typeof binary==='string'&&/taskkill[.]exe$/i.test(binary)){",
        "   const fake=new events.EventEmitter();",
        "   fake.kill=()=>true;",
        "   process.nextTick(()=>fake.emit('error',",
        "     Object.assign(new Error('test-only taskkill failure'),{code:'ENOENT'})));",
        "   return fake;",
        " }",
        " return original.apply(this,arguments);",
        "};",
        "require('node:module').syncBuiltinESMExports();",
      ].join('\n'));
      child=spawn(process.execPath,['--require',taskkillFailurePreload,cli,
        '--print','--provider','deepseek','--cwd',root,'--session-id',sessionId,
        '--max-retries','0','--max-turns','3','--compact-threshold','0',
        '--allowedTools','Bash('+command+')',
        '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
        'Run Bash once'],{
        env:{...process.env,
          DEEPSEEK_API_KEY:'only-local-unconfirmed-test'},
        stdio:['ignore','pipe','pipe'],
      });
      const out=[],err=[];
      child.stdout.on('data',b=>out.push(b));
      child.stderr.on('data',b=>err.push(b));
      closed=new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('close',(code,signal)=>resolve({code,signal}));
      });
      watchdog=setTimeout(()=>child.kill('SIGKILL'),14000);
      const result=await closed;
      const stdout=Buffer.concat(out).toString('utf8');
      const stderr=Buffer.concat(err).toString('utf8');
      assert.equal(result.signal,null,stdout+stderr);
      assert.equal(result.code,1,stdout+stderr);
      assert.match(stderr,/process-tree cleanup could not be confirmed/);
      assert.equal(requests.length,1,
        'an unconfirmed Windows Bash cleanup must stop before a second model call');
      assert.ok((await readOptional(beatFile)).length>0,
        'the OS-side effect occurred before taskkill failed');
      const jsonl=await readFile(join(root,'.agent-cil','sessions',
        sessionId,'transcript.jsonl'),'utf8');
      const records=jsonl.trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.map(x=>x.kind),
        ['input','tool_pending','tool_started'],
        'do not persist a fake tool_result when descendants remain unowned');
    } finally {
      if(watchdog)clearTimeout(watchdog);
      if(child&&child.exitCode===null)child.kill('SIGKILL');
      if(closed)await closed.catch(()=>{});
      await killIfRunning(pidFile);
      server.closeAllConnections?.();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    }
  });
});
