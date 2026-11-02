import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>'event: '+type+'\ndata: '+
  JSON.stringify({type,...data})+'\n\n';
function finalStream(index) {
  return frame('message_start',{message:{usage:{input_tokens:12}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'MODEL_SESSION_ROUND_'+index,
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:5}})+
    frame('message_stop');
}
const shellQuote=x=>"'"+x.replaceAll("'","'\\''")+"'";

// Only a real TTY triggers the in-process CLI REPL. The packed-installed
// Node entry point is provided by AGENT_CIL_TEST_EXECUTABLE in CI. Pure
// adapter tests below cover the Windows transport; use 'script' on Linux to
// prove model commands never enter the provider or committed transcript.
test('real interactive CLI /model changes next streamed request without losing old conversation or journaling commands',{
  timeout:50000,skip:process.platform==='win32',
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-interactive-model-'));
  const sessionId=randomUUID();
  const configPath=join(root,'config.json');
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream(requests.length));
  });
  let child,closed,watchdog;
  let output='',errors='',sent=0;
  const commands=[
    '/model opus',
    'Second prompt after switch',
    '/model sonnet[1m]',
    '/model',
    '/model default',
    'Third prompt after reset',
    '/exit',
  ];
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const args=[process.execPath,cli,
      '--model','haiku','--cwd',root,'--session-id',sessionId,
      '--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port,
      'First prompt uses the original haiku selection'];
    child=spawn('script',['-q','-e','-c',args.map(shellQuote).join(' '),'/dev/null'],{
      env:{...process.env,ANTHROPIC_API_KEY:'fixture-interactive-model-key',
        // Default is an explicit null override, not this environment value.
        ANTHROPIC_MODEL:'haiku',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'',
        ANTHROPIC_DEFAULT_OPUS_MODEL:'',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'',
        AGENT_CIL_CONFIG_PATH:configPath},
      stdio:['pipe','pipe','pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      output+=chunk;
      const promptCount=output.split('you> ').length-1;
      if(promptCount>sent && sent<commands.length){
        child.stdin.write(commands[sent]+'\n');
        sent++;
      }
    });
    child.stderr.on('data',chunk=>{errors+=chunk;});
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),32000);
    const result=await closed;
    assert.equal(result.signal,null,errors+output);
    assert.equal(result.code,0,errors+output);
    assert.equal(sent,commands.length,errors+output);
    assert.deepEqual(requests.map(x=>x.model),[
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ],'Default must clear the startup --model override and return to the runtime default');
    assert.match(output,/Set model to claude-opus-5-5/);
    assert.match(output,/Set model to claude-sonnet-5-5\[1m\]/);
    assert.match(output,/Current model: claude-sonnet-5-5\[1m\]/);
    assert.match(output,/Set model to claude-sonnet-5-5/);
    assert.match(output,/MODEL_SESSION_ROUND_3/);
    const second=JSON.stringify(requests[1].messages);
    const third=JSON.stringify(requests[2].messages);
    assert.match(second,/First prompt uses the original haiku selection/);
    assert.match(third,/Second prompt after switch/);
    assert.doesNotMatch(third,/sonnet\[1m\]|\/model opus|\/model default/,
      'local /model control lines must never become model-visible prompts');
    const records=(await readFile(join(root,'.agent-cil','sessions',
      sessionId,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(x=>x.kind==='input').length,3,
      'only three real user prompts belong to source UUID-linked transcript');
    assert.equal(records.at(-1).kind,'finished');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    assert.equal(config.model,undefined,'/model default must remove the saved model preference');
    const runResumed=(args,provider='anthropic')=>new Promise((resolve,reject)=>{
      const next=spawn(process.execPath,[cli,'--print','--cwd',root,
        '--resume',sessionId,'--model',
        provider==='anthropic'?'opus':'deepseek-flash',
        '--provider',provider,'--max-retries','0','--compact-threshold','0',
        '--base-url','http://127.0.0.1:'+server.address().port,...args],{
        env:{...process.env,ANTHROPIC_API_KEY:'fixture-interactive-model-key',
          DEEPSEEK_API_KEY:'fixture-interactive-deepseek-key',
          ANTHROPIC_MODEL:'haiku',
          ANTHROPIC_DEFAULT_SONNET_MODEL:'',
          ANTHROPIC_DEFAULT_OPUS_MODEL:'',
          ANTHROPIC_DEFAULT_HAIKU_MODEL:'',
          AGENT_CIL_CONFIG_PATH:configPath},
        stdio:['ignore','pipe','pipe'],
      });
      const output=[];
      next.stdout.on('data',chunk=>output.push(chunk));
      next.stderr.on('data',chunk=>output.push(chunk));
      next.once('error',reject);
      next.once('close',(code,signal)=>resolve({
        code,signal,output:Buffer.concat(output).toString('utf8'),
      }));
    });
    const resumed=await runResumed(['Fourth prompt after restoring Default']);
    assert.equal(resumed.signal,null,resumed.output);
    assert.equal(resumed.code,0,resumed.output);
    assert.match(resumed.output,/Restored session model: claude-sonnet-5-5/);
    assert.deepEqual(requests.map(x=>x.model),[
      'claude-haiku-5-5','claude-opus-5-5',
      'claude-sonnet-5-5','claude-sonnet-5-5',
    ],'explicit Default must survive --resume over --model and ANTHROPIC_MODEL');
    assert.doesNotMatch(JSON.stringify(requests[3].messages),/\/model default/,
      'Default metadata must not become a model-visible message');
    const beforeProviderSwitch=requests.length;
    const denied=await runResumed(['Do not send to another provider'],'deepseek');
    assert.equal(denied.signal,null,denied.output);
    assert.equal(denied.code,2,denied.output);
    assert.match(denied.output,/model override belongs to provider anthropic/);
    assert.equal(requests.length,beforeProviderSwitch);
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});


test('real TTY /model rolls back the session checkpoint when persisted settings cannot be written',{
  timeout:50000,skip:process.platform==='win32',
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-model-save-failure-'));
  const sessionId=randomUUID();
  const configDirectory=join(root,'blocked-config');
  const configPath=join(configDirectory,'config.json');
  await mkdir(configDirectory);
  await writeFile(configPath,JSON.stringify({language:'en'}));
  // Keep startup reads valid, but deny the atomic temp-file creation used by
  // saveModelPreference(). An unreadable config path would correctly stop the
  // CLI before the interactive /model rollback path could be exercised.
  await chmod(configDirectory,0o500);
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream(requests.length));
  });
  let child,closed,watchdog;
  let output='',sent=0;
  const commands=['/model opus','Second prompt after failed persistence','/exit'];
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const args=[process.execPath,cli,'--model','sonnet','--cwd',root,
      '--session-id',sessionId,'--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port,
      'First prompt before failed model switch'];
    child=spawn('script',['-q','-e','-c',args.map(shellQuote).join(' '),'/dev/null'],{
      env:{...process.env,ANTHROPIC_API_KEY:'fixture-model-save-failure-key',
        ANTHROPIC_MODEL:'',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'',
        ANTHROPIC_DEFAULT_OPUS_MODEL:'',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'',
        AGENT_CIL_CONFIG_PATH:configPath},
      stdio:['pipe','pipe','pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      output+=chunk;
      const prompts=output.split('you> ').length-1;
      if(prompts>sent && sent<commands.length){
        child.stdin.write(commands[sent]+'\n');
        sent++;
      }
    });
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),32000);
    const result=await closed;
    assert.equal(result.signal,null,output);
    assert.equal(result.code,0,output);
    assert.equal(sent,commands.length,output);
    assert.match(output,/Model unchanged: Could not persist model preference:.*EACCES/);
    assert.deepEqual(requests.map(x=>x.model),[
      'claude-sonnet-5-5','claude-sonnet-5-5',
    ]);
    const records=(await readFile(join(root,'.agent-cil','sessions',
      sessionId,'transcript.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.filter(x=>x.kind==='model_override').map(x=>x.setting),
      ['opus','sonnet'],'failed persistence must restore the actual startup model');
    // Restart with a different --model: the durable rollback must retain
    // the actual pre-failure model rather than accidentally choosing Default.
    const resumed=await new Promise((resolve,reject)=>{
      const next=spawn(process.execPath,[cli,'--print','--cwd',root,
        '--resume',sessionId,'--model','haiku',
        '--max-retries','0','--compact-threshold','0',
        '--base-url','http://127.0.0.1:'+server.address().port,
        'Third prompt after restarting the failed model switch'],{
        env:{...process.env,ANTHROPIC_API_KEY:'fixture-model-save-failure-key',
          ANTHROPIC_MODEL:'',
          ANTHROPIC_DEFAULT_SONNET_MODEL:'',
          ANTHROPIC_DEFAULT_OPUS_MODEL:'',
          ANTHROPIC_DEFAULT_HAIKU_MODEL:'',
          AGENT_CIL_CONFIG_PATH:configPath},
        stdio:['ignore','pipe','pipe'],
      });
      const output=[];
      next.stdout.on('data',chunk=>output.push(chunk));
      next.stderr.on('data',chunk=>output.push(chunk));
      next.once('error',reject);
      next.once('close',(code,signal)=>resolve({
        code,signal,output:Buffer.concat(output).toString('utf8'),
      }));
    });
    assert.equal(resumed.signal,null,resumed.output);
    assert.equal(resumed.code,0,resumed.output);
    assert.match(resumed.output,/Restored session model: claude-sonnet-5-5/);
    assert.deepEqual(requests.map(x=>x.model),[
      'claude-sonnet-5-5','claude-sonnet-5-5','claude-sonnet-5-5',
    ],'failed persistence must retain the pre-failure model after process restart');
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await chmod(configDirectory,0o700).catch(()=>{});
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});


test('real TTY /model persists the default and --resume restores its session override above new --model',{
  timeout:70000,skip:process.platform==='win32',
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-cross-process-model-'));
  const id=randomUUID();
  const configPath=join(root,'config.json');
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(finalStream(requests.length));
  });
  let child,closed,watchdog;
  let output='',sent=0;
  const commands=['/model opus','/exit'];
  const runNonInteractive=argv=>new Promise((resolve,reject)=>{
    const next=spawn(process.execPath,[cli,'--print','--cwd',root,
      '--resume',id,'--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port,
      ...argv],{
      env:{...process.env,ANTHROPIC_API_KEY:'fixture-cross-process-model-key',
        DEEPSEEK_API_KEY:'fixture-cross-process-deepseek-key',
        ANTHROPIC_MODEL:'',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'',
        ANTHROPIC_DEFAULT_OPUS_MODEL:'',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'',
        AGENT_CIL_CONFIG_PATH:configPath},
      stdio:['ignore','pipe','pipe'],
    });
    const stdout=[],stderr=[];
    next.stdout.on('data',c=>stdout.push(c));
    next.stderr.on('data',c=>stderr.push(c));
    next.once('error',reject);
    next.once('close',(code,signal)=>resolve({
      code,signal,output:Buffer.concat(stdout).toString('utf8')+
        Buffer.concat(stderr).toString('utf8'),
    }));
  });
  const runFresh=prompt=>new Promise((resolve,reject)=>{
    const next=spawn(process.execPath,[cli,'--print','--cwd',root,
      '--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port,prompt],{
      env:{...process.env,ANTHROPIC_API_KEY:'fixture-cross-process-model-key',
        ANTHROPIC_MODEL:'',
        ANTHROPIC_DEFAULT_SONNET_MODEL:'',
        ANTHROPIC_DEFAULT_OPUS_MODEL:'',
        ANTHROPIC_DEFAULT_HAIKU_MODEL:'',
        AGENT_CIL_CONFIG_PATH:configPath},
      stdio:['ignore','pipe','pipe'],
    });
    const stdout=[],stderr=[];
    next.stdout.on('data',c=>stdout.push(c));
    next.stderr.on('data',c=>stderr.push(c));
    next.once('error',reject);
    next.once('close',(code,signal)=>resolve({
      code,signal,output:Buffer.concat(stdout).toString('utf8')+
        Buffer.concat(stderr).toString('utf8'),
    }));
  });
  try{
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    const cmd=[process.execPath,cli,'--cwd',root,'--session-id',id,
      '--model','sonnet','--max-retries','0','--compact-threshold','0',
      '--base-url','http://127.0.0.1:'+server.address().port,
      'First conversation before switching'];
    child=spawn('script',['-q','-e','-c',cmd.map(shellQuote).join(' '),'/dev/null'],{
      env:{...process.env,ANTHROPIC_API_KEY:'fixture-cross-process-model-key',
        AGENT_CIL_CONFIG_PATH:configPath},
      stdio:['pipe','pipe','pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      output+=chunk;
      const prompts=output.split('you> ').length-1;
      if(prompts>sent && sent<commands.length){
        child.stdin.write(commands[sent]+'\n');
        sent++;
      }
    });
    closed=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    watchdog=setTimeout(()=>child.kill('SIGKILL'),35000);
    const first=await closed;
    assert.equal(first.signal,null,output);
    assert.equal(first.code,0,output);
    assert.equal(sent,2,output);
    assert.match(output,/Set model to claude-opus-5-5/);
    assert.equal(requests.length,1,output);
    const savedConfig=JSON.parse(await readFile(configPath,'utf8'));
    assert.equal(savedConfig.model,'opus','interactive /model must persist the default for future sessions');

    const fresh=await runFresh('A new session must use the saved Opus preference');
    assert.equal(fresh.signal,null,fresh.output);
    assert.equal(fresh.code,0,fresh.output);
    assert.deepEqual(requests.map(x=>x.model),[
      'claude-sonnet-5-5','claude-opus-5-5',
    ]);

    const transcriptPath=join(root,'.agent-cil','sessions',id,'transcript.jsonl');
    const initialRecords=(await readFile(transcriptPath,'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(initialRecords.at(-1).kind,'model_override');
    assert.equal(initialRecords.at(-1).setting,'opus');
    assert.equal(initialRecords.at(-1).provider,'anthropic');

    // A restart with an explicit different startup --model must keep the
    // previous in-session /model setting, matching original precedence.
    const continued=await runNonInteractive([
      '--model','haiku','Second prompt after process restart',
    ]);
    assert.equal(continued.signal,null,continued.output);
    assert.equal(continued.code,0,continued.output);
    assert.match(continued.output,/Restored session model: claude-opus-5-5/);
    assert.deepEqual(requests.map(x=>x.model),[
      'claude-sonnet-5-5','claude-opus-5-5','claude-opus-5-5',
    ]);
    assert.match(JSON.stringify(requests[2].messages),
      /First conversation before switching/);
    assert.doesNotMatch(JSON.stringify(requests[2].messages),/\/model opus/);
    const checkpoint=(await readFile(transcriptPath,'utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.deepEqual(checkpoint.filter(x=>x.kind==='input').map(x=>x.kind),
      ['input','input']);
    assert.equal(checkpoint.at(-1).kind,'finished');

    // A provider switch must not inject the previous Anthropic alias into
    // an unrelated API and must fail before the model network request.
    const count=requests.length;
    const blocked=await runNonInteractive([
      '--provider','deepseek','--model','deepseek-flash',
      'Never send an Anthropic model override to DeepSeek',
    ]);
    assert.equal(blocked.signal,null,blocked.output);
    assert.equal(blocked.code,2,blocked.output);
    assert.match(blocked.output,/model override belongs to provider anthropic/);
    assert.equal(requests.length,count);
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child&&child.exitCode===null)child.kill('SIGKILL');
    if(closed)await closed.catch(()=>{});
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
