import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSessionJournal} from '../src/legacy-session/session-storage.js';

const input=[{role:'user',content:'Preserve the completed tool/result history.'}];
async function exitedPid(){
  const child=spawn(process.execPath,['-e','process.exit(0)'],{
    stdio:'ignore',windowsHide:true,
  });
  const pid=child.pid;
  const [code]=await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve([code,signal]));
  });
  assert.equal(code,0);
  return pid;
}
async function waitForFile(path,timeout=9000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{await stat(path);return;}
    catch(error){if(error?.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,18));
  }
  throw new Error('Timed out waiting for competing real process: '+path);
}
async function seed(root,id){
  const journal=await openSessionJournal({workspace:root,sessionId:id});
  await journal.append({messages:input,kind:'input'});
  const path=journal.path;
  await journal.close();
  return path;
}
const staleLock=(pid)=>JSON.stringify({
  pid,startedAt:0,token:randomUUID(),
})+'\n';

test('stale-lock recovery guard rejects a concurrent claim without replacing the stale lock or transcript',{
  timeout:22000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-lock-claim-'));
  const id=randomUUID();
  let journal;
  try{
    const path=await seed(root,id);
    const old=await readFile(path,'utf8');
    const lock=path+'.lock';
    const bytes=staleLock(await exitedPid());
    await writeFile(lock,bytes);
    // Another process holds the exclusive stale-recovery claim.
    const marker=lock+'.reclaim';
    await writeFile(marker,JSON.stringify({
      pid:process.pid,startedAt:Date.now(),token:randomUUID(),
    })+'\n');
    await assert.rejects(
      openSessionJournal({workspace:root,sessionId:id,resume:true}),
      /Another process is recovering this session lock/,
    );
    assert.equal(await readFile(lock,'utf8'),bytes);
    assert.equal(await readFile(path,'utf8'),old);
    await rm(marker);
    journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    assert.deepEqual(journal.messages,input);
    await assert.rejects(stat(marker),{code:'ENOENT'});
    await journal.close();journal=null;
    await assert.rejects(stat(lock),{code:'ENOENT'});
  }finally{
    if(journal)await journal.close().catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
});

test('two independent Node processes racing to recover one dead owner cannot both acquire/write the session',{
  timeout:35000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-lock-race-'));
  const id=randomUUID();
  const children=[];
  try{
    const path=await seed(root,id);
    await writeFile(path+'.lock',staleLock(await exitedPid()));
    const moduleUrl=new URL('../src/legacy-session/session-storage.js',import.meta.url).href;
    const worker=[
      'import {openSessionJournal} from '+JSON.stringify(moduleUrl)+';',
      "import {writeFile,stat} from 'node:fs/promises';",
      "import {join} from 'node:path';",
      'const root=process.env.AGENT_CIL_LOCK_TEST_ROOT;',
      'const id=process.env.AGENT_CIL_LOCK_TEST_SESSION;',
      'const suffix=process.env.AGENT_CIL_LOCK_TEST_INDEX;',
      'const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));',
      "await writeFile(join(root,'ready-'+suffix),'1');",
      'let released=false;',
      'for(let i=0;i<800;i++){',
      " try{await stat(join(root,'go'));released=true;break;}",
      " catch(e){if(e.code!=='ENOENT')throw e;}",
      ' await pause(12);',
      '}',
      "if(!released)throw Error('Timed out waiting for concurrent start');",
      'let journal;',
      'try{',
      ' journal=await openSessionJournal({workspace:root,sessionId:id,resume:true});',
      " await journal.append({messages:[...journal.messages,{role:'assistant',",
      "  content:[{type:'text',text:'owner '+suffix}]}],kind:'finished'});",
      " process.stdout.write('acquired '+suffix);",
      ' await pause(1300);',
      ' await journal.close();journal=null;',
      '}catch(e){',
      " process.stderr.write('blocked '+suffix+': '+e.message);",
      ' process.exitCode=17;',
      '}finally{if(journal)await journal.close().catch(()=>{});}',
    ].join('\n');
    const resultPromises=[];
    for(const index of ['a','b']){
      const child=spawn(process.execPath,
        ['--input-type=module','--eval',worker],{
          env:{...process.env,
            AGENT_CIL_LOCK_TEST_ROOT:root,
            AGENT_CIL_LOCK_TEST_SESSION:id,
            AGENT_CIL_LOCK_TEST_INDEX:index},
          stdio:['ignore','pipe','pipe'],windowsHide:true,
        });
      children.push(child);
      let stdout='',stderr='';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data',x=>{stdout+=x;});
      child.stderr.on('data',x=>{stderr+=x;});
      resultPromises.push(new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
      }));
    }
    await Promise.all(['a','b'].map(index=>waitForFile(join(root,'ready-'+index))));
    await writeFile(join(root,'go'),'1');
    const results=await Promise.all(resultPromises);
    assert.deepEqual(results.map(x=>x.signal),[null,null],JSON.stringify(results));
    const winners=results.filter(x=>x.code===0);
    const blocked=results.filter(x=>x.code===17);
    assert.equal(winners.length,1,JSON.stringify(results));
    assert.equal(blocked.length,1,JSON.stringify(results));
    assert.match(winners[0].stdout,/acquired [ab]/);
    assert.match(blocked[0].stderr,/already active|recovering this session lock/);
    const reopened=await openSessionJournal({workspace:root,sessionId:id,resume:true});
    try{
      assert.deepEqual(reopened.messages.map(x=>x.role),['user','assistant']);
      assert.match(reopened.messages[1].content[0].text,/^owner [ab]$/);
    }finally{await reopened.close();}
    await assert.rejects(stat(path+'.lock'),{code:'ENOENT'});
    await assert.rejects(stat(path+'.lock.reclaim'),{code:'ENOENT'});
  }finally{
    for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');
    await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
  }
});
