import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPreToolUseHookSettings } from '../../runtime/src/legacy-tools/pretooluse-node-compat.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
function frame(type, data = {}) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n';
}
function toolStream(id, input) {
  return frame('message_start', {message:{usage:{input_tokens:33}}}) +
    frame('content_block_start', {index:0,content_block:{type:'tool_use',id,name:'Write',input:{}}}) +
    frame('content_block_delta', {index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}}) +
    frame('content_block_stop', {index:0}) +
    frame('message_delta', {delta:{stop_reason:'tool_use'},usage:{output_tokens:10}}) +
    frame('message_stop');
}
function finalStream() {
  return frame('message_start', {message:{usage:{input_tokens:44}}}) +
    frame('content_block_start', {index:0,content_block:{type:'text',text:''}}) +
    frame('content_block_delta', {index:0,delta:{type:'text_delta',text:'Hook decision observed.'}}) +
    frame('content_block_stop',{index:0}) +
    frame('message_delta',{delta:{stop_reason:'end_turn'},usage:{output_tokens:5}}) +
    frame('message_stop');
}

test('2.1.88 hook settings reject unsupported callbacks and event types (no silent skip)', async () => {
  const root = await mkdtemp(join(tmpdir(),'agent-hook-validation-'));
  try {
    const file = join(root,'hooks.json');
    await writeFile(file, JSON.stringify({hooks:{PreToolUse:[{
      matcher:'Write',hooks:[{type:'prompt',prompt:'do something'}]
    }]}}));
    await assert.rejects(loadPreToolUseHookSettings(file), /Only synchronous/);
    await writeFile(file, JSON.stringify({hooks:{PostToolUse:[] ,PreToolUse:[]}}));
    await assert.rejects(loadPreToolUseHookSettings(file), /Only PreToolUse/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('real CLI uses original PreToolUse permission behavior, input rewrite, and safety precedence', {
  timeout:60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(),'agent-cil-pretooluse-cli-'));
  async function runScenario(mode, originalInput, args = [], output = undefined) {
    const script = join(root,'prehook.cjs');
    const settings = join(root,'hook-settings.json');
    const response = output ?? {
      hookSpecificOutput: {hookEventName:'PreToolUse', permissionDecision:mode,
        permissionDecisionReason:'PreToolUse fixture '+mode}
    };
    await writeFile(script,
      "let body='';process.stdin.on('data', c => body+=c);"+
      "process.stdin.on('end',()=>{const input=JSON.parse(body);"+
      "if(input.hook_event_name!=='PreToolUse'||input.tool_name!=='Write')process.exit(9);"+
      "process.stdout.write("+JSON.stringify(JSON.stringify(response))+");});"
    );
    await writeFile(settings,JSON.stringify({hooks:{PreToolUse:[{
      matcher:'Write',hooks:[{type:'command',command:'node prehook.cjs',timeout:8}]
    }]}}));
    const requests = [];
    const server = createServer(async (req,res) => {
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests.push(body);
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(requests.length===1
        ? toolStream('hook-tool-'+mode,originalInput) : finalStream());
    });
    let child,killTimer;
    try {
      await new Promise((resolve,reject) => {
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
      });
      child=spawn(process.execPath,[
        cli,'--print','--provider','deepseek','--cwd',root,'--max-turns','3',
        '--compact-threshold','0','--max-retries','0',
        '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
        '--hooks-file',settings,...args,'Use Write tool once.'
      ], {env:{...process.env,DEEPSEEK_API_KEY:'local-hook-token'},stdio:['ignore','pipe','pipe']});
      const out=[],err=[];
      child.stdout.on('data',c=>out.push(c));child.stderr.on('data',c=>err.push(c));
      killTimer=setTimeout(()=>child.kill('SIGKILL'),16000);
      const [code,signal]=await new Promise((done,fail)=>{
        child.once('error',fail);child.once('close',(code,signal)=>done([code,signal]));
      });
      const stdout=Buffer.concat(out).toString('utf8');
      const stderr=Buffer.concat(err).toString('utf8');
      assert.equal(signal,null,stdout+stderr);
      assert.equal(code,0,stdout+stderr);
      assert.match(stdout,/Hook decision observed/);
      assert.equal(requests.length,2);
      const block=requests[1].messages.at(-1).content[0];
      assert.equal(block.tool_use_id,'hook-tool-'+mode);
      assert.equal(stderr.includes('local-hook-token'),false);
      return block;
    } finally {
      if(killTimer)clearTimeout(killTimer);
      if(child&&child.exitCode===null&&!child.killed)child.kill('SIGKILL');
      server.closeAllConnections?.();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    }
  }
  try {
    const allow=await runScenario('allow',{file_path:'approved.txt',content:'hook allowed'});
    assert.equal(allow.is_error,undefined);
    assert.equal(await readFile(join(root,'approved.txt'),'utf8'),'hook allowed');
    const deny=await runScenario('deny',{file_path:'denied.txt',content:'should not write'},['--allow-edits']);
    assert.equal(deny.is_error,true,'Hook deny beats acceptEdits');
    await assert.rejects(stat(join(root,'denied.txt')),{code:'ENOENT'});
    const ask=await runScenario('ask',{file_path:'ask.txt',content:'should not write'},['--allow-edits']);
    assert.equal(ask.is_error,true,'Hook ask forces review even if baseline allowed');
    await assert.rejects(stat(join(root,'ask.txt')),{code:'ENOENT'});
    // Cross-port invariant: 2.1.88 source resolveHookPermissionDecision
    // MUST not bypass the 2.1.88 permissionRuleParser and explicit deny/ask
    // sources restored in the other draft PR.
    const explicitDeny=await runScenario('allow',
      {file_path:'rule-denied.txt',content:'not permitted'},
      ['--allowedTools','Write','--disallowedTools','Write']);
    assert.equal(explicitDeny.is_error,true,'explicit deny always overrides Hook allow');
    await assert.rejects(stat(join(root,'rule-denied.txt')),{code:'ENOENT'});
    const explicitAsk=await runScenario('allow',
      {file_path:'rule-ask.txt',content:'must prompt'},
      ['--allowedTools','Write','--askTools','Write']);
    assert.equal(explicitAsk.is_error,true,'explicit ask still requires approval despite Hook allow');
    await assert.rejects(stat(join(root,'rule-ask.txt')),{code:'ENOENT'});
    const unsafeRewrite=await runScenario('allow',
      {file_path:'safe-first.txt',content:'initial'},[],{
      hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',
        updatedInput:{file_path:'../escaped-by-hook.txt',content:'outside'}}
    });
    assert.equal(unsafeRewrite.is_error,true,'Hook rewritten input is revalidated before policy allow');
    await assert.rejects(stat(join(root,'..','escaped-by-hook.txt')),{code:'ENOENT'});

    const outside=await runScenario('allow',{file_path:'../unsafe-hook.txt',content:'outside'});
    assert.equal(outside.is_error,true,'Hook allow cannot evade workspace');
    await assert.rejects(stat(join(root,'..','unsafe-hook.txt')),{code:'ENOENT'});
    const rewrite=await runScenario('allow',{file_path:'original.txt',content:'original'},[],{
      hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',
        updatedInput:{file_path:'rewritten.txt',content:'rewritten'}}
    });
    assert.equal(rewrite.is_error,undefined);
    assert.equal(await readFile(join(root,'rewritten.txt'),'utf8'),'rewritten');
    await assert.rejects(stat(join(root,'original.txt')),{code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
});
