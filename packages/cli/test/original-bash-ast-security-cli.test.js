import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,stat,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOriginalBashForSecurity} from
  '../../runtime/src/legacy-permissions/bash-original-ast-security.js';
import {bashToolCheckAstPermission} from
  '../../runtime/src/legacy-permissions/bash-ast-permission.js';
import {createBuiltinTools,createCliPermissionContext,createCliPermissionPolicy,parseArgs} from '../src/index.js';
import {isDangerousRemovalPath,filterOutFlags,checkDangerousRemovalPaths} from
  '../../runtime/src/legacy-permissions/bash-original-dangerous-path.js';
import {stripWrappersFromArgv} from
  '../../runtime/src/legacy-permissions/generated/stripWrappers.js';
import {PATH_EXTRACTORS,COMMAND_VALIDATOR} from
  '../../runtime/src/legacy-permissions/generated/originalPathExtractors.js';
import {checkOriginalWritePathSafety,checkOriginalEditScopedRules,checkOriginalReadPathSafety,checkOriginalReadScopedRules,hasSuspiciousWindowsPathPattern} from '../../runtime/src/legacy-permissions/original-bash-read-paths.js';
import {validateBashReadPath,getPathsForPermissionCheck} from
  '../../runtime/src/legacy-permissions/original-bash-read-paths.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const LF=String.fromCharCode(10);
function frame(type,data={}){
  return 'event: '+type+LF+'data: '+JSON.stringify({type,...data})+LF+LF;
}
const stream=(command,toolName='Bash')=>
  frame('message_start',{message:{usage:{input_tokens:17}}})+
  frame('content_block_start',{index:0,content_block:{
    type:'tool_use',id:'source-ast-bash',name:toolName,input:{},
  }})+
  frame('content_block_delta',{index:0,delta:{
    type:'input_json_delta',partial_json:JSON.stringify(toolName==='Read'?{file_path:command}:toolName==='Write'?{file_path:command,content:'EDIT_SCOPED_WRITTEN'}:{command}),
  }})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'tool_use'}})+
  frame('message_stop');
const finalStream=()=>
  frame('message_start',{message:{usage:{input_tokens:19}}})+
  frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
  frame('content_block_delta',{index:0,delta:{
    type:'text_delta',text:'ORIGINAL_BASH_AST_VERIFIED',
  }})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'end_turn'}})+
  frame('message_stop');

test('actual pinned 2.1.88 Bash AST produces structured argv and original subcommand positions',{
  timeout:30000,
},async()=>{
  const simple=await parseOriginalBashForSecurity('node --version');
  assert.equal(simple.kind,'simple',JSON.stringify(simple));
  assert.deepEqual(simple.commands.map(x=>x.argv),[['node','--version']]);
  const compound=await parseOriginalBashForSecurity('echo harmless && node --version');
  assert.equal(compound.kind,'simple',JSON.stringify(compound));
  assert.deepEqual(compound.commands.map(x=>x.argv[0]),['echo','node']);
  assert.equal(compound.commands[1].text.startsWith('node'),true);
  // The original source checks parse ambiguities, command substitution,
  // control-flow and unusual shell syntax instead of regex-based auto allow.
  for(const command of [
    'echo $(node --version)',
    'eval something',
    'bash -c "node --version"',
  ]) {
    const decision=await parseOriginalBashForSecurity(command);
    assert.notEqual(decision.kind,'parse-unavailable',command);
  }
});

test('original Read path safety rejects suspicious Windows aliases before workspace grants',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-read-path-safety-'));
  try{
    const context=createCliPermissionContext();
    for(const path of [
      'file.txt:stream',
      'file~1.txt',
      'report.NUL',
      'trailing-dot.',
      '.../secret.txt',
      '.../../normalized-away.txt',
      'folder./file.txt',
      'folder /file.txt',
      String.raw`\??\C:\secret.txt`,
      String.raw`C:\safe\DavWWWRoot\share`,
      '/net/server/share',
      '/.vol/1/secret.txt',
    ]){
      assert.equal(hasSuspiciousWindowsPathPattern(path,'windows'),true,
        '2.1.304 classifier must reject '+JSON.stringify(path));
      const checked=checkOriginalReadPathSafety(path,root,context,'windows');
      assert.equal(checked.behavior,'ask',path+': '+JSON.stringify(checked));
    }
    const safe=checkOriginalReadPathSafety('src/index.js',root,context,'windows');
    assert.equal(safe.behavior,'passthrough',JSON.stringify(safe));
    const integrated=checkOriginalReadScopedRules('file~1.txt',root,context);
    assert.equal(integrated.behavior,'ask',JSON.stringify(integrated));
    const policy=createCliPermissionPolicy({workspace:root,permissionContext:context});
    const readDecision=await policy({name:'Read',input:{file_path:'file~1.txt'}});
    assert.equal(readDecision.behavior,'ask',JSON.stringify(readDecision));
    const grepDecision=await policy({name:'Grep',input:{path:'file~1.txt'}});
    assert.equal(grepDecision.behavior,'ask',JSON.stringify(grepDecision));
    const unc=checkOriginalReadPathSafety('//server/share/secret.txt',root,context,'windows');
    assert.equal(unc.behavior,'ask',JSON.stringify(unc));
    assert.match(unc.decisionReason?.reason,/UNC path/i);
    const tempOutput=checkOriginalReadPathSafety(join(tmpdir(),'agent-cil-output.txt'),root,context);
    assert.equal(tempOutput.behavior,'passthrough',JSON.stringify(tempOutput));
    const suspiciousTempSuffix=checkOriginalReadPathSafety(join(tmpdir(),'file~1.txt'),root,context);
    assert.equal(suspiciousTempSuffix.behavior,'ask',JSON.stringify(suspiciousTempSuffix));

    if(process.platform!=='win32'){
      const loopA=join(root,'loop-a');
      const loopB=join(root,'loop-b');
      await symlink('loop-b',loopA);
      await symlink('loop-a',loopB);
      const loop=checkOriginalReadPathSafety('loop-a/file.txt',root,context);
      assert.equal(loop.behavior,'ask',JSON.stringify(loop));
      assert.match(loop.decisionReason?.reason,/unvettable read path ancestry/i);
    }

    // Simulate short-name/canonical-root mapping with a POSIX symlink.
    // Native Windows uses its real tmpdir/8.3 path integration tests below;
    // a literal directory named RUNNER~1 is not a genuine Windows short name.
    if(process.platform!=='win32'){
    const shortRoot=join(root,'RUNNER~1');
    await mkdir(shortRoot);
    const trustedPrefix=checkOriginalReadPathSafety('safe.txt',shortRoot,context,'windows');
    assert.equal(trustedPrefix.behavior,'passthrough',JSON.stringify(trustedPrefix));
    const untrustedSuffix=checkOriginalReadPathSafety('file~1.txt',shortRoot,context,'windows');
    assert.equal(untrustedSuffix.behavior,'ask',JSON.stringify(untrustedSuffix));
    const absoluteSafe=checkOriginalReadPathSafety(join(shortRoot,'safe.txt'),shortRoot,context,'windows');
    assert.equal(absoluteSafe.behavior,'passthrough',JSON.stringify(absoluteSafe));
    const absoluteUnsafe=checkOriginalReadPathSafety(shortRoot+'/.../../safe.txt',shortRoot,context,'windows');
    assert.equal(absoluteUnsafe.behavior,'ask',JSON.stringify(absoluteUnsafe));

    // Model the Windows runner's realpath mapping from RUNNER~1 to its long
    // user-profile name. A sibling authenticated temp-output path may share
    // that trusted OS prefix without being inside the CLI workspace.
    const longRoot=join(root,'runneradmin');
    const shortAlias=join(root,'RUNNER~2');
    await mkdir(join(longRoot,'workspace'),{recursive:true});
    try{
      await symlink(longRoot,shortAlias,'dir');
      const externalTaskOutput=checkOriginalReadPathSafety(
        shortAlias+'/agent-cil-task-output.output',
        join(shortAlias,'workspace'),context,'windows',
      );
      assert.equal(externalTaskOutput.behavior,'passthrough',JSON.stringify(externalTaskOutput));
      const externalSuspiciousSuffix=checkOriginalReadPathSafety(
        shortAlias+'/file~1.txt',
        join(shortAlias,'workspace'),context,'windows',
      );
      assert.equal(externalSuspiciousSuffix.behavior,'ask',JSON.stringify(externalSuspiciousSuffix));
    }catch(error){
      if(!['EPERM','EACCES','ENOSYS'].includes(error?.code))throw error;
    }
    }

    // Exercise the same policy entry point used by AgentLoop on native
    // Windows; ADS syntax must be rejected before the workspace auto-read.
    if(process.platform==='win32'){
      const decision=await policy({name:'Read',input:{file_path:'file.txt:stream'}});
      assert.equal(decision.behavior,'ask',JSON.stringify(decision));
      assert.match(decision.reason,/suspicious Windows path/i);
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

test('original AST integrates with pinned Bash deny/ask rule parser; complex commands never auto-allow',{
  timeout:30000,
},async()=>{
  const ctx=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}],
    deny:[{toolName:'Bash',ruleContent:'node:*'}],
    ask:[],
  }});
  const checked=await bashToolCheckAstPermission({
    command:'echo harmless && node --version',
  },ctx);
  assert.equal(checked.behavior,'deny',JSON.stringify(checked));
  const ordinary=await bashToolCheckAstPermission({
    command:'node --version',
  },createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash',ruleContent:'node --version'}],deny:[],ask:[],
  }}));
  assert.equal(ordinary.behavior,'allow',JSON.stringify(ordinary));
  // The AST cannot justify automatic broad prefix/wildcard authorization
  // until original redirection/path validation and sandbox checks are ported.
  assert.throws(()=>parseArgs([
    '--allowedTools','Bash(node:*)','test',
  ]),/wildcard\/prefix/);
});

test('original AST subcommand DENY outranks full-command ASK and path approval ASK',{
  timeout:30000,
},async()=>{
  const askAndDeny=createCliPermissionContext({permissionRules:{
    allow:[],
    deny:[{toolName:'Bash',ruleContent:'rm:*'}],
    ask:[{toolName:'Bash',ruleContent:'*echo*'}],
  }});
  const askDecision=await bashToolCheckAstPermission({
    command:'echo harmless && rm -f guarded.txt',
  },askAndDeny);
  assert.equal(askDecision.behavior,'deny',JSON.stringify(askDecision));
  assert.match(JSON.stringify(askDecision.decisionReason),/rm:\*/);

  const pathAsk=createCliPermissionContext({permissionRules:{
    allow:[],
    deny:[{toolName:'Bash',ruleContent:'rm:*'}],
    ask:[],
  }});
  const pathDecision=await bashToolCheckAstPermission({
    command:'cd .claude && rm -f guarded.txt',
  },pathAsk);
  assert.equal(pathDecision.behavior,'deny',JSON.stringify(pathDecision));
  assert.match(JSON.stringify(pathDecision.decisionReason),/rm:\*/);
});

test('packed real CLI enforces a Bash subcommand deny before cd/write path approval',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    command:'cd .claude && rm -f guarded.txt',
    flags:['--allowedTools','Bash','--disallowedTools','Bash(rm:*)'],
    files:[['guarded.txt','KEEP']],
    expectedWrites:[['guarded.txt','KEEP']],
    shouldFail:true,
  });
  assert.match(result.output,/has been denied/i);
});

test('packed real CLI preserves acceptEdits when a Bash content deny does not match the verified AST leaf',{
  timeout:85000,
},async()=>{
  await testActualCli({
    command:'touch content-restricted.txt',
    flags:['--allow-edits','--disallowedTools','Bash(node:*)'],
    expectedWrites:[['content-restricted.txt','']],
    shouldFail:false,
  });
});

test('original AST restores exact Bash allow for a verified sequential && list but keeps cd/git guards',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-exact-compound-allow-'));
  try{
    const command='touch first.txt && touch second.txt';
    const allowed=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash',ruleContent:command}],deny:[],ask:[],
    }});
    const result=await bashToolCheckAstPermission({command},allowed,{workspace:root});
    assert.equal(result.behavior,'allow',JSON.stringify(result));
    assert.equal(result.decisionReason?.type,'rule');

    await mkdir(join(root,'.claude'));
    const cdGit='cd .claude && git status';
    const cdGitAllowed=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:cdGit}],deny:[],ask:[],
    }});
    const blocked=await bashToolCheckAstPermission({command:cdGit},cdGitAllowed,{workspace:root});
    assert.equal(blocked.behavior,'ask',JSON.stringify(blocked));
    assert.match(blocked.message,/cd and git/i);

    const multiCd='cd .claude && cd ..';
    const multiCdAllowed=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:multiCd}],deny:[],ask:[],
    }});
    const multi=await bashToolCheckAstPermission({command:multiCd},multiCdAllowed,{workspace:root});
    assert.equal(multi.behavior,'ask',JSON.stringify(multi));
    assert.match(multi.message,/Multiple directory changes/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed real CLI executes an exact source-authorized Bash sequential && list',{
  timeout:85000,
},async()=>{
  await testActualCli({
    command:'touch first.txt && touch second.txt',
    flags:['--allow-edits','--allowedTools','Bash(touch first.txt && touch second.txt)'],
    expectedWrites:[['first.txt',''],['second.txt','']],
    shouldFail:false,
  });
});

test('original AST applies acceptEdits to each verified compound filesystem leaf only',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-accept-edits-compound-'));
  try{
    const context=createCliPermissionContext({allowEdits:true});
    const command='touch first.txt && touch second.txt';
    const allowed=await bashToolCheckAstPermission({command},context,{workspace:root});
    assert.equal(allowed.behavior,'allow',JSON.stringify(allowed));
    assert.equal(allowed.decisionReason?.type,'subcommandResults');

    const mixedReadWrite=await bashToolCheckAstPermission({
      command:'pwd && touch first.txt',
    },context,{workspace:root});
    assert.equal(mixedReadWrite.behavior,
      process.platform==='win32'?'ask':'allow',JSON.stringify(mixedReadWrite));

    const mixed=await bashToolCheckAstPermission({
      command:'touch first.txt && node -e "process.exit(0)"',
    },context,{workspace:root});
    assert.notEqual(mixed.behavior,'allow',JSON.stringify(mixed));
  }finally{await rm(root,{recursive:true,force:true})}
});

test('original 2.1.88 operator gate blocks AST-extracted subshells before any allow',{
  timeout:30000,
},async()=>{
  const command='(pwd; whoami)';
  const parsed=await parseOriginalBashForSecurity(command);
  assert.equal(parsed.kind,'simple',JSON.stringify(parsed));
  assert.deepEqual(parsed.commands.map(command=>command.argv[0]),['pwd','whoami']);
  assert.deepEqual(parsed.compoundStructure,{
    hasCompoundOperators:false,
    hasPipeline:false,
    hasSubshell:true,
    hasCommandGroup:false,
    operators:[],
    segments:['(pwd; whoami)'],
  });

  // 2.1.304 extends the original top-level walk through pipelines and their
  // children, so a nested subshell cannot disappear behind a pipeline node.
  const pipeline=await parseOriginalBashForSecurity('(pwd) | cat');
  assert.equal(pipeline.kind,'simple',JSON.stringify(pipeline));
  assert.equal(pipeline.compoundStructure?.hasPipeline,true);
  assert.equal(pipeline.compoundStructure?.hasSubshell,true);

  // The 2.1.304 traversal follows for_statement/do_group wrappers as well.
  const loop=await parseOriginalBashForSecurity('for item in one; do (pwd); done');
  assert.equal(loop.kind,'simple',JSON.stringify(loop));
  assert.equal(loop.compoundStructure?.hasSubshell,true);
  const context=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}],deny:[],ask:[],
  }});
  const result=await bashToolCheckAstPermission({command},context);
  assert.equal(result.behavior,'ask',JSON.stringify(result));
  assert.match(result.message,/shell operators.*approval/i);
});

test('packed real CLI does not let whole-tool Bash allow authorize a subshell',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    command:'(pwd; whoami)',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
  });
  assert.match(result.output,/shell operators|approval|permission/i);
});

test('original 2.1.88 compound analysis matches top-level redirected subshell and command-group behavior',{
  timeout:30000,
},async()=>{
  const redirected=await parseOriginalBashForSecurity(
    'pwd && (whoami) 2>/dev/null',
  );
  assert.equal(redirected.kind,'simple',JSON.stringify(redirected));
  assert.equal(redirected.compoundStructure?.hasCompoundOperators,true);
  assert.deepEqual(redirected.compoundStructure?.operators,['&&']);
  assert.equal(redirected.compoundStructure?.hasSubshell,true);

  const commandGroup='{ pwd; whoami; }';
  const parsedGroup=await parseOriginalBashForSecurity(commandGroup);
  assert.notEqual(parsedGroup.kind,'parse-unavailable',JSON.stringify(parsedGroup));
  const context=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}],deny:[],ask:[],
  }});
  const groupResult=await bashToolCheckAstPermission(
    {command:commandGroup},context,
  );
  assert.equal(groupResult.behavior,'ask',JSON.stringify(groupResult));
});

test('packed real CLI does not let whole-tool Bash allow authorize a command group',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    command:'{ touch group-marker.txt; }',
    flags:['--allowedTools','Bash'],
    mustNotCreate:'group-marker.txt',
    shouldFail:true,
  });
  assert.match(result.output,/approval|permission/i);
});

test('packed real CLI applies acceptEdits to every verified Bash compound filesystem leaf',{
  timeout:85000,
},async()=>{
  await testActualCli({
    command:'touch first.txt && touch second.txt',
    flags:['--allow-edits'],
    expectedWrites:[['first.txt',''],['second.txt','']],
    shouldFail:false,
  });
});

test('packed real CLI applies POSIX read/write compound approval only on verified platforms',{
  timeout:85000,
},async()=>{
  if(process.platform==='win32'){
    const denied=await testActualCli({
      command:'pwd && touch first.txt',
      flags:['--allow-edits'],
      mustNotCreate:'first.txt',
      shouldFail:true,
    });
    assert.match(String(denied.output),/approval|permission/i);
    return;
  }
  await testActualCli({
    command:'pwd && touch first.txt',
    flags:['--allow-edits'],
    expectedWrites:[['first.txt','']],
    shouldFail:false,
  });
});

async function testActualCli({command,flags,shouldFail,mustNotCreate,files=[],expectedWrites=[],outputFilePattern,toolName='Bash',setup}) {
  const root=await mkdtemp(join(tmpdir(),'agent-bash-ast-cli-'));
  const actualCommand=typeof command==='function'?command(root):command;
  for(const [name,content] of files){
    const filePath=join(root,name);
    // Integration fixtures may include nested paths such as subdir/secret.txt.
    await mkdir(dirname(filePath),{recursive:true});
    await writeFile(filePath,content);
  }
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(requests.length===1?stream(actualCommand,toolName):finalStream());
  });
  let child,timeout;
  try{
    // Real git init belongs to the same owned fixture lifecycle: if setup
    // fails, the finally block must still release the temporary directory.
    if(setup)await setup(root);
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-turns','3','--max-retries','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      ...flags,'exercise original Bash source AST'],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-ast-test'},
      stdio:['ignore','pipe','pipe'],
    });
    const output=[],errors=[];
    child.stdout.on('data',x=>output.push(x));
    child.stderr.on('data',x=>errors.push(x));
    timeout=setTimeout(()=>child.kill('SIGKILL'),25000);
    const [status,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(c,s)=>resolve([c,s]));
    });
    const stdout=Buffer.concat(output).toString('utf8'),
      stderr=Buffer.concat(errors).toString('utf8');
    assert.equal(signal,null,stderr);
    assert.equal(status,0,stderr);
    assert.match(stdout,/ORIGINAL_BASH_AST_VERIFIED/);
    assert.equal(requests.length,2);
    const result=requests[1].messages.at(-1).content.find(
      x=>x.type==='tool_result'&&x.tool_use_id==='source-ast-bash');
    assert.ok(result,'real Query must retain original authenticated tool ID');
    assert.equal(result.is_error===true,shouldFail,JSON.stringify(result));
    if(mustNotCreate) {
      await assert.rejects(stat(join(root,mustNotCreate)),{code:'ENOENT'},
        'denied file path must not reach the filesystem');
    }
    // Exercise actual OS bytes before the helper's mandatory cleanup. The
    // canonical Write tool result reports {path,bytes,written}, NOT content.
    for(const [fileName,expectedContent] of expectedWrites){
      assert.equal(await readFile(join(root,fileName),'utf8'),expectedContent,
        'packed CLI Write must persist exact authenticated model content');
    }
    if(outputFilePattern){
      assert.match(await readFile(join(root,outputFilePattern[0]),'utf8'),
        outputFilePattern[1],'Source-approved Bash redirect must actually write file bytes');
    }
    return {root,output:result.content};
  }finally{
    if(timeout)clearTimeout(timeout);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
test('Windows original /c alias executes in real Bash while unverified /cygdrive stays on approval path',{
  skip:process.platform!=='win32' && 'Windows POSIX mount validation requires native Windows',
  timeout:30000,
},async()=>{
  // Compare actual pinned 2.1.88 utils/path.ts#expandPath with
  // windowsPaths.ts#posixPathToWindowsPath: only /C/... is converted by
  // the mature source path entry. Git Bash uses MSYS2 /C/... mounts,
  // not the Cygwin /cygdrive/C/... default; never widen allow by merely
  // discovering support for a path in a lower-level conversion helper.
  const {expandOriginalPath}=await import(
    '../../runtime/src/legacy-permissions/original-bash-read-paths.js');
  const root=await mkdtemp(join(tmpdir(),'agent-cil-cygdrive-'));
  try{
    const drive=/^([A-Za-z]):[\\/]/.exec(root);
    assert.ok(drive,'Windows test workspace must be rooted on a drive');
    const suffix=root.slice(2).replaceAll('\\','/')+'/safe.txt';
    const msys='/'+drive[1].toLowerCase()+suffix;
    const cygdrive='/cygdrive/'+drive[1].toLowerCase()+suffix;
    const within=join(root,'safe.txt');
    await writeFile(within,'ORIGINAL_PATH_ALIAS');
    assert.equal(expandOriginalPath(msys,root),within,
      'pinned 2.1.88 source must map native MSYS2 /C mounts');
    const nativeCommand='cat "'+msys+'"';
    const context=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:nativeCommand}],deny:[],ask:[],
    }});
    const allowed=await bashToolCheckAstPermission({command:nativeCommand},
      context,{workspace:root});
    assert.equal(allowed.behavior,'allow',JSON.stringify(allowed));
    // This is the actual Job Object -> bash.exe -> TaskOutput execution,
    // not a test-only imitation of the runtime's native filesystem.
    const nativeBash=(await createBuiltinTools({workspace:root})).get('Bash');
    const executed=await nativeBash.execute({
      command:nativeCommand,timeout_ms:10000,
    });
    assert.equal(executed.exit_code,0,JSON.stringify(executed));
    assert.equal(executed.stdout.trim(),'ORIGINAL_PATH_ALIAS');
    assert.notEqual(expandOriginalPath(cygdrive,root),within,
      'original 2.1.88 path entry does not assume Cygwin mount equivalence');
    const sourceCommand='cat "'+cygdrive+'"';
    const sourceContext=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:sourceCommand}],deny:[],ask:[],
    }});
    const checked=await bashToolCheckAstPermission({command:sourceCommand},
      sourceContext,{workspace:root});
    assert.equal(checked.behavior,'ask',JSON.stringify(checked));
    assert.match(checked.message,/Cygwin|cygdrive/i);
    const outside='/cygdrive/'+drive[1].toLowerCase()+'/Windows/outside-workspace.txt';
    const denied=await bashToolCheckAstPermission({command:'cat "'+outside+'"'},
      createCliPermissionContext({permissionRules:{
        allow:[{toolName:'Bash',ruleContent:'cat "'+outside+'"'}],deny:[],ask:[],
      }}),{workspace:root});
    assert.notEqual(denied.behavior,'allow',JSON.stringify(denied));
    const redirected=await bashToolCheckAstPermission({
      command:'echo text > "'+cygdrive+'"',
    },createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }}),{workspace:root});
    assert.notEqual(redirected.behavior,'allow',JSON.stringify(redirected));
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});

test('Windows packed CLI executes original MSYS drive path through live tool_result',{
  skip:process.platform!=='win32' && 'Real Git Bash/Windows path behavior requires native Windows',
  timeout:85000,
},async()=>{
  // One installed/native CLI process, actual local SSE model request,
  // original AST permission, Job Object Bash, and authenticated result.
  // The same /C alias is accepted by the mature 2.1.88 path entry and
  // resolves to the fixture's actual native Windows file.
  const result=await testActualCli({
    command:root=>{
      const drive=/^([A-Za-z]):[\\/]/.exec(root);
      assert.ok(drive);
      return 'cat "/'+drive[1].toLowerCase()+
        root.slice(2).replaceAll('\\','/')+'/safe.txt"';
    },
    flags:['--allowedTools','Bash'],
    files:[['safe.txt','MSYS2_REAL_CLI_READ_VERIFIED']],
    expectedWrites:[['safe.txt','MSYS2_REAL_CLI_READ_VERIFIED']],
    shouldFail:false,
  });
  assert.match(String(result.output),/MSYS2_REAL_CLI_READ_VERIFIED/);
});

test('Windows real streamed CLI refuses a Cygwin drive path outside its workspace',{
  skip:process.platform!=='win32' && 'Native Bash/Windows path authorization requires a Windows runner',
  timeout:85000,
},async()=>{
  // This goes through the real CLI -> streamed local model -> original
  // Bash AST -> read-path validation -> authenticated tool result. A broad
  // Bash allow must never turn an outside-volume path into workspace access.
  const result=await testActualCli({
    command:root=>{
      const drive=/^([A-Za-z]):[\\/]/.exec(root);
      assert.ok(drive);
      return 'cat "/cygdrive/'+drive[1].toLowerCase()+'/Windows/win.ini"';
    },
    flags:['--allowedTools','Bash','--permission-mode','acceptEdits'],
    shouldFail:true,
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});

test('source checkSemanticsDeny keeps explicit subcommand DENY instead of downgrading it to ask',{
  timeout:30000,
},async()=>{
  // 2.1.88 bashPermissions.ts:1774-1795 -> checkSemanticsDeny().
  // Bash(echo:*) allow must not hide a denied eval/exec under the AST
  // semantic rejection. This is a rule-denial contract, not a shell parser
  // substitute or permission classifier.
  const invalid=await parseOriginalBashForSecurity(
    'echo harmless && eval "echo forbidden"');
  assert.equal(invalid.kind,'too-complex',JSON.stringify(invalid));
  assert.equal(invalid.semanticFailure,true,JSON.stringify(invalid));
  assert.deepEqual(invalid.sourceCommands.map(x=>x.argv[0]),
    ['echo','eval']);
  const ctx=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}],
    deny:[{toolName:'Bash',ruleContent:'eval:*'}],
    ask:[],
  }});
  const decision=await bashToolCheckAstPermission({
    command:'echo harmless && eval "echo forbidden"',
  },ctx);
  assert.equal(decision.behavior,'deny',JSON.stringify(decision));
  assert.equal(decision.decisionReason?.type,'rule');
  assert.equal(decision.decisionReason?.rule?.ruleValue?.ruleContent,'eval:*');
});


test('pinned 2.1.88 BashTool pathValidation: rm/rmdir dangerous roots and -- flag paths',{
  timeout:30000,
},async()=>{
  // Never actually execute destructive paths in tests.
  for(const path of ['/', '/tmp', '/etc','C:\\\\','C:\\\\Windows']){
    assert.equal(isDangerousRemovalPath(path),true,path);
  }
  assert.deepEqual(filterOutFlags(['-rf','--','-/../../etc','./a']),
    ['-/../../etc','./a']);
  assert.equal(checkDangerousRemovalPaths('rm',['-rf','/'],process.cwd()).behavior,'ask');
  assert.equal(checkDangerousRemovalPaths('rm',['-rf','./safe'],process.cwd()).behavior,'passthrough');
  assert.deepEqual(stripWrappersFromArgv(
    ['timeout','5','env','KEY=ok','rm','-rf','/']),
    ['rm','-rf','/']);
  assert.deepEqual(stripWrappersFromArgv(
    ['stdbuf','-o0','-eL','rm','-rf','/']),
    ['rm','-rf','/']);
  const context=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'},{toolName:'Bash',ruleContent:'rm -rf /'}],
    deny:[],ask:[],
  }});
  for(const command of [
    'rm -rf /','rmdir /','env KEY=ok rm -rf /',
    'timeout 5 rm -rf /','echo ok && rm -rf /',
  ]){
    const result=await bashToolCheckAstPermission(
      {command},context,{workspace:process.cwd()});
    assert.notEqual(result.behavior,'allow',
      'original path checks may not be bypassed by Bash allow: '+command);
    assert.equal(result.behavior,'ask',
      'dangerous removal requires manual approval: '+command);
  }
});

test('packed real CLI: exact permitted Bash still executes with original AST preflight',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'node --version',
    flags:['--allowedTools','Bash(node --version)'],
    shouldFail:false,
  });
  assert.match(result.output,/v[0-9]+/);
});
test('packed real CLI: whole Bash allow cannot bypass AST subcommand deny in compound',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'echo harmless && node --version',
    flags:['--allowedTools','Bash','--disallowedTools','Bash(node:*)'],
    shouldFail:true,
  });
  assert.match(result.output,/denied|approval|requires/i);
});

test('packed real CLI: original semantic rejection still honors explicit eval prefix DENY',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'echo harmless && eval "echo forbidden"',
    flags:['--allowedTools','Bash','--disallowedTools','Bash(eval:*)'],
    shouldFail:true,
  });
  assert.match(result.output,/has been denied/,
    'original semantic-deny rule must not downgrade to generic ask');
});

if(process.platform!=='win32'){
  test('packed CLI keeps Bash whole-tool allow but refuses original dangerous removal target',{
    timeout:35000,
  },async()=>{
    // Real rm would see a nonexistent intermediate path even if the
    // permission check regressed; the test must never risk a real deletion.
    const result=await testActualCli({
      command:'rm -rf ./missing-agent-cil-path/../..',
      flags:['--allowedTools','Bash'],
      shouldFail:true,
    });
    assert.match(result.output,/approval|requires|permission/i);
  });
}

test('original 2.1.88 AST redirection target never inherits whole-tool Bash allow',{
  timeout:30000,
},async()=>{
  const command='node --version > ./untrusted-output.txt';
  const parsed=await parseOriginalBashForSecurity(command);
  assert.equal(parsed.kind,'simple',JSON.stringify(parsed));
  assert.ok(parsed.commands[0].redirects.length>0,
    'native source AST must retain redirection path evidence');
  const context=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}],deny:[],ask:[],
  }});
  const decision=await bashToolCheckAstPermission(
    {command},context,{workspace:process.cwd()});
  assert.equal(decision.behavior,'ask',JSON.stringify(decision));
  assert.match(decision.message,/create.path authorization|original create/i);
});

test('packed live CLI refuses output redirection even with whole Bash auto-allow',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'node --version > ./untrusted-output.txt',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'untrusted-output.txt',
  });
  assert.match(result.output,/requires|approval|permission/i);
});


test('pinned original path extractors enforce missing filesystem validation without breaking path-free git',{
  timeout:30000,
},async()=>{
  assert.deepEqual(PATH_EXTRACTORS.git(['status']),[],
    'git status must preserve the source empty-path contract');
  assert.deepEqual(PATH_EXTRACTORS.git(['diff','--no-index','/etc/passwd','./file']),
    ['/etc/passwd','./file']);
  assert.deepEqual(PATH_EXTRACTORS.rm(['-rf','--','-/../.claude/settings.json']),
    ['-/../.claude/settings.json']);
  assert.equal(COMMAND_VALIDATOR.mv(['--target-directory=/etc']),false);
  assert.deepEqual(PATH_EXTRACTORS.grep(['NO_UNLIKELY_MATCH']),[]);
  assert.deepEqual(PATH_EXTRACTORS.grep(['NO_UNLIKELY_MATCH','/dev/null']),['/dev/null']);
  const context=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'}, {toolName:'Bash',ruleContent:'cat /etc/passwd'}],
    deny:[],ask:[],
  }});
  for(const command of [
    'cat /etc/passwd',
    'grep NO_UNLIKELY_MATCH /dev/null',
    'timeout 5 cat /etc/passwd',
    'env KEY=ok touch ./must-not-create',
    'git diff --no-index /etc/passwd ./test',
    'mv --target-directory=/etc',
  ]){
    const result=await bashToolCheckAstPermission(
      {command},context,{workspace:process.cwd()});
    assert.equal(result.behavior,'ask',command+' '+JSON.stringify(result));
    assert.match(result.message,/approval|requires|blocked|manual/i);
  }
  const status=await bashToolCheckAstPermission(
    {command:'git status'},context,{workspace:process.cwd()});
  assert.equal(status.behavior,process.platform==='win32'?'passthrough':'allow',
    'source Git no-path operation is auto-approved only after cwd/bare-repo safety');
});

test('packed live CLI: original touch path extractor fences whole Bash allow before OS mutation',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'touch ./must-not-create',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'must-not-create',
  });
  assert.match(result.output,/checkPathConstraints|approval|requires/i);
});


test('2.1.304 relative reads after cd cannot bypass scoped Read deny rules',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-cd-read-deny-'));
  try{
    await mkdir(join(root,'subdir'));
    await writeFile(join(root,'secret.txt'),'ROOT_SAFE');
    await writeFile(join(root,'subdir','secret.txt'),'SUBDIR_SECRET');
    const deniedContext=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[{toolName:'Read',ruleContent:'subdir/secret.txt'}],
      ask:[],
    }});
    const denied=await bashToolCheckAstPermission(
      {command:'cd subdir && cat secret.txt'},deniedContext,{workspace:root});
    assert.equal(denied.behavior,'ask',JSON.stringify(denied));
    assert.equal(denied.decisionReason?.bashMissKind,'cd-compound-read',JSON.stringify(denied));

    // The 2.1.304 source predicate also recognizes a whole-tool Read deny,
    // not only content-specific Read(path) rules.
    const wholeReadDenyContext=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],deny:[{toolName:'Read'}],ask:[],
    }});
    const wholeReadDenied=await bashToolCheckAstPermission(
      {command:'cd subdir && cat secret.txt'},wholeReadDenyContext,{workspace:root});
    assert.equal(wholeReadDenied.behavior,'ask',JSON.stringify(wholeReadDenied));
    assert.equal(wholeReadDenied.decisionReason?.bashMissKind,'cd-compound-read',
      JSON.stringify(wholeReadDenied));

    const ordinaryContext=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    const ordinary=await bashToolCheckAstPermission(
      {command:'cd subdir && cat secret.txt'},ordinaryContext,{workspace:root});
    assert.equal(ordinary.behavior,'allow',JSON.stringify(ordinary));
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test('2.1.88 validatePath read-only original symlink chain and working-directory boundaries',{
  timeout:30000,
},async()=>{
  const {writeFile,symlink}=await import('node:fs/promises');
  const path=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'agent-read-path-'));
  const outside=await mkdtemp(join(tmpdir(),'agent-read-outside-'));
  const ctx=createCliPermissionContext({permissionRules:{
    allow:[{toolName:'Bash'},{toolName:'Bash',ruleContent:'cat ./inside.txt'}],deny:[],ask:[],
  }});
  try{
    await writeFile(join(root,'inside.txt'),'SAFE_SOURCE_READ');
    await writeFile(join(outside,'secret.txt'),'DO_NOT_READ');
    assert.equal(validateBashReadPath('./inside.txt',root,ctx).allowed,true);
    assert.equal(validateBashReadPath('~/../outside',root,ctx).allowed,false);
    assert.equal(validateBashReadPath('~root/.ssh',root,ctx).allowed,false);
    assert.equal(validateBashReadPath('$HOME/.ssh',root,ctx).allowed,false);
    assert.equal(validateBashReadPath(path.join(outside,'secret.txt'),root,ctx).allowed,false);
    const scopedRead=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'cat ./inside.txt'}],
      deny:[{toolName:'Read',ruleContent:'inside.txt'}],ask:[],
    }});
    const failClosed=await bashToolCheckAstPermission({
      command:'cat ./inside.txt',
    },scopedRead,{workspace:root});
    assert.equal(failClosed.behavior,'deny',JSON.stringify(failClosed));
    assert.equal(failClosed.decisionReason?.type,'rule');
    const otherRead=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'cat ./inside.txt'}],
      deny:[{toolName:'Read',ruleContent:'not-inside.txt'}],ask:[],
    }});
    assert.equal(validateBashReadPath('inside.txt',root,otherRead).allowed,true);
    const askedRead=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'cat ./inside.txt'}],
      deny:[],ask:[{toolName:'Read',ruleContent:'inside.txt'}],
    }});
    assert.equal((await bashToolCheckAstPermission({
      command:'cat ./inside.txt',
    },askedRead,{workspace:root})).behavior,'ask');
    const wildcardRead=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'cat ./inside.txt'}],
      deny:[{toolName:'Read',ruleContent:'**/*.txt'}],ask:[],
    }});
    assert.equal(validateBashReadPath('inside.txt',root,wildcardRead).allowed,false);
    if(process.platform!=='win32'){
      await symlink(path.join(outside,'secret.txt'),join(root,'escape.txt'));
      const aliases=getPathsForPermissionCheck(join(root,'escape.txt'));
      assert.ok(aliases.includes(path.join(outside,'secret.txt')),JSON.stringify(aliases));
      assert.equal(validateBashReadPath('escape.txt',root,ctx).allowed,false);
      const escaped=await bashToolCheckAstPermission({command:'cat escape.txt'},ctx,{workspace:root});
      assert.equal(escaped.behavior,'ask',JSON.stringify(escaped));
    }
  }finally{
    await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});
  }
});

test('packed real CLI: exact approved Bash cat within workspace uses original read path validation',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'cat ./inside.txt',
    flags:['--allowedTools','Bash(cat ./inside.txt)'],
    files:[['inside.txt','ORIGINAL_PATH_READ_OK']],
    shouldFail:false,
  });
  assert.match(result.output,/ORIGINAL_PATH_READ_OK/,
    'OS Bash cat must actually read verified workspace file');
});

test('original Read(path) rules govern built-in Read and source per-file search filtering',{
  timeout:30000,
},async()=>{
  const path=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'agent-read-file-rule-'));
  const outside=await mkdtemp(join(tmpdir(),'agent-read-file-rule-outside-'));
  try{
    await writeFile(join(root,'protected.txt'),'READ_DENIED');
    await writeFile(join(root,'ok.txt'),'OK');
    const ctx=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Read'},{toolName:'Bash',ruleContent:'cat protected.txt'}],
      deny:[{toolName:'Read',ruleContent:'protected.txt'}],
      ask:[],
    }});
    const policy=createCliPermissionPolicy({workspace:root,permissionContext:ctx});
    assert.equal((await policy({name:'Read',input:{file_path:'protected.txt'}})).behavior,'deny');
    assert.equal((await policy({name:'Read',input:{file_path:'ok.txt'}})).behavior,'allow');
    assert.equal((await policy({name:'Grep',input:{path:'.',pattern:'DENIED'}})).behavior,'allow',
      'Grep(root) should not be blocked by an unrelated denied child file');
    assert.equal((await policy({name:'Glob',input:{pattern:'**/*'}})).behavior,'allow',
      'Glob(root) should not be blocked by an unrelated denied child file');
    assert.equal((await policy({name:'Grep',input:{path:'protected.txt',pattern:'DENIED'}})).behavior,'deny',
      'Grep on the exact denied source path must preserve original rule precedence');
    assert.equal((await policy({name:'Bash',input:{command:'cat protected.txt'}})).behavior,'ask');
    const wholeDeny=createCliPermissionPolicy({workspace:root,
      permissionContext:createCliPermissionContext({permissionRules:{
        allow:[],deny:[{toolName:'Read'},{toolName:'Grep'},{toolName:'Glob'}],
        ask:[{toolName:'Read',ruleContent:'protected.txt'}],
      }}),
    });
    for(const [name,input] of [
      ['Read',{file_path:'protected.txt'}],
      ['Grep',{path:'.',pattern:'READ_DENIED'}],
      ['Glob',{pattern:'**/*'}],
    ]){
      assert.equal((await wholeDeny({name,input})).behavior,'deny',
        name+' explicit whole-tool deny must override a scoped ask');
    }
    const outsidePath=path.join(outside,'secret.txt');
    assert.equal((await policy({name:'Read',input:{file_path:outsidePath}})).behavior,'deny');
    const matches=parseArgs(['--disallowedTools','Read(**/*.txt)','--print','test']);
    assert.equal(matches.permissionRules.deny[0].ruleContent,'**/*.txt');
    assert.equal((await policy({name:'Read',input:{file_path:'ok.txt'}})).behavior,'allow');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test('packed CLI honors Read(path) deny before whole Read allow and preserves result',{
  timeout:35000,
},async()=>{
  const forbidden=await testActualCli({
    toolName:'Read',
    command:'protected.txt',
    flags:['--allowedTools','Read','--disallowedTools','Read(protected.txt)'],
    files:[['protected.txt','DO_NOT_LEAK_CONTENT']],
    shouldFail:true,
  });
  assert.doesNotMatch(JSON.stringify(forbidden.output),/DO_NOT_LEAK_CONTENT/);
  const authorized=await testActualCli({
    toolName:'Read',
    command:'safe.txt',
    flags:['--allowedTools','Read','--disallowedTools','Read(protected.txt)'],
    files:[['protected.txt','DO_NOT_LEAK_CONTENT'],['safe.txt','AUTHORIZED_READ_OK']],
    shouldFail:false,
  });
  assert.match(JSON.stringify(authorized.output),/AUTHORIZED_READ_OK/);
});

test('scoped Read deny cannot be bypassed by Bash recursive or unclassified readers',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-read-enumeration-'));
  try{
    await writeFile(join(root,'protected.txt'),'DO_NOT_EXPOSE');
    const ctx=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'rg DO_NOT_EXPOSE .'},
        {toolName:'Bash',ruleContent:'ls .'},
        {toolName:'Bash',ruleContent:'node -e noop'}],
      deny:[{toolName:'Read',ruleContent:'protected.txt'}],ask:[],
    }});
    for(const command of ['rg DO_NOT_EXPOSE .','ls .','node -e noop']){
      const decision=await bashToolCheckAstPermission({command},ctx,{workspace:root});
      assert.notEqual(decision.behavior,'allow',command+': '+JSON.stringify(decision));
    }
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test('original auto-edit safety protects sensitive files, Windows patterns, and symlink escapes',{
  timeout:30000,
},async()=>{
  const path=await import('node:path');
  const fs=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'agent-original-write-safety-'));
  const outside=await mkdtemp(join(tmpdir(),'agent-original-write-outside-'));
  const ctx=createCliPermissionContext({allowEdits:true});
  try{
    const writeSafety=checkOriginalWritePathSafety('normal.txt',root,ctx);
    assert.equal(writeSafety.behavior,'passthrough',JSON.stringify({
      platform:process.platform,root,safety:writeSafety,
      rootAliases:getPathsForPermissionCheck(root),
      pathAliases:getPathsForPermissionCheck(join(root,'normal.txt')),
    }));
    if(process.platform==='win32'){
      // A trusted OS-supplied 8.3 root must not disable all native edits;
      // user supplied 8.3 suffixes must STILL require manual approval.
      assert.equal(checkOriginalWritePathSafety('user~1/config.txt',root,ctx).behavior,'ask');
      assert.equal(checkOriginalWritePathSafety('.claude/settings.json',root,ctx).behavior,'ask');
    }
    for(const name of [
      '.git/config','.GiT/config','.claude/settings.json','.CLAUDE/AGENTS/work.md',
      '.vscode/settings.json','.idea/workspace.xml','.bashrc','.GitModules',
      'CONFIG~1/foo.txt','setup.json.','path/.../file.txt','file.txt.PRN',
    ]){
      assert.equal(checkOriginalWritePathSafety(name,root,ctx).behavior,'ask',name);
    }
    assert.equal(checkOriginalWritePathSafety('../outside.txt',root,ctx).behavior,'ask');
    if(process.platform!=='win32'){
      await fs.symlink(outside,path.join(root,'linked-dir'),'dir');
      assert.equal(checkOriginalWritePathSafety('linked-dir/new.txt',root,ctx).behavior,'ask');
      await fs.symlink(path.join(outside,'missing.txt'),path.join(root,'broken.txt'));
      assert.equal(checkOriginalWritePathSafety('broken.txt',root,ctx).behavior,'ask');
    }
    assert.equal(checkOriginalWritePathSafety('.claude/worktrees/feature.txt',root,ctx).behavior,'passthrough');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test('source 2.1.88 Edit(path) deny/ask/allow applies to native Write and Edit',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-scoped-edit-'));
  try{
    const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Write'}],
      deny:[{toolName:'Edit',ruleContent:'blocked.txt'}],
      ask:[{toolName:'Edit',ruleContent:'review.txt'}],
    }});
    const policy=createCliPermissionPolicy({workspace:root,permissionContext:ctx});
    for(const toolName of ['Write','Edit']){
      const deny=await policy({name:toolName,input:{file_path:'blocked.txt'}});
      assert.equal(deny.behavior,'deny',toolName+JSON.stringify(deny));
      assert.equal(deny.decisionReason?.rule?.ruleValue?.ruleContent,'blocked.txt');
      assert.equal((await policy({name:toolName,input:{file_path:'review.txt'}})).behavior,'ask');
      assert.equal((await policy({name:toolName,input:{file_path:'safe.txt'}})).behavior,'allow');
    }
    const allowContext=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Edit',ruleContent:'allowed.txt'}],deny:[],ask:[],
    }});
    const allowPolicy=createCliPermissionPolicy({workspace:root,permissionContext:allowContext});
    assert.equal((await allowPolicy({name:'Write',input:{file_path:'allowed.txt'}})).behavior,'allow');
    assert.equal((await allowPolicy({name:'Edit',input:{file_path:'allowed.txt'}})).behavior,'allow');
    assert.equal((await allowPolicy({name:'Write',input:{file_path:'unmatched.txt'}})).behavior,'ask');
    assert.equal((await allowPolicy({name:'Write',input:{file_path:'.git/config'}})).behavior,'ask',
      'Edit allow must not bypass original sensitive path approval');
    assert.equal(checkOriginalEditScopedRules('blocked.txt',root,ctx,'deny').behavior,'deny');
    const parsed=parseArgs(['--allowedTools','Edit(allowed.txt)',
      '--disallowedTools','Edit(**/blocked.txt)','--askTools','Edit(review.txt)','--print','test']);
    assert.deepEqual(parsed.permissionRules.allow,[{toolName:'Edit',ruleContent:'allowed.txt'}]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('source Edit(path) DENY beats Bash exact allow and accepts no OS side effects',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-scoped-edit-bash-'));
  try{
    const ctx=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'touch blocked.txt'}],
      deny:[{toolName:'Edit',ruleContent:'blocked.txt'}],ask:[],
    }});
    const checked=await bashToolCheckAstPermission({command:'touch blocked.txt'},ctx,{workspace:root});
    assert.equal(checked.behavior,'deny',JSON.stringify(checked));
    const askCtx=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'touch review.txt'}],
      deny:[],ask:[{toolName:'Edit',ruleContent:'review.txt'}],
    }});
    assert.equal((await bashToolCheckAstPermission({command:'touch review.txt'},askCtx,{workspace:root})).behavior,'ask');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed real CLI Edit(path) deny blocks Write while scoped allow writes safe file',{
  timeout:35000,
},async()=>{
  const denied=await testActualCli({toolName:'Write',command:'blocked.txt',
    flags:['--allowedTools','Write','--disallowedTools','Edit(blocked.txt)'],
    shouldFail:true,mustNotCreate:'blocked.txt'});
  assert.doesNotMatch(JSON.stringify(denied.output),/EDIT_SCOPED_WRITTEN/);
  const allowed=await testActualCli({toolName:'Write',command:'allowed.txt',
    flags:['--allowedTools','Edit(allowed.txt)'],shouldFail:false,
    expectedWrites:[['allowed.txt','EDIT_SCOPED_WRITTEN']]});
  assert.match(JSON.stringify(allowed.output),/written/);
  const reviewed=await testActualCli({toolName:'Write',command:'review.txt',
    flags:['--allow-edits','--askTools','Edit(review.txt)'],
    shouldFail:true,mustNotCreate:'review.txt'});
});

test('old AST classifies output, fd copies and file-backed input without shell regex',{
  timeout:30000,
},async()=>{
  const {astRedirectsToOutputRedirections}=await import(
    '../../runtime/src/legacy-permissions/original-bash-redirections.js');
  const parsed=await parseOriginalBashForSecurity(
    'node --version > out.txt 2>&1');
  assert.equal(parsed.kind,'simple',JSON.stringify(parsed));
  const redirects=parsed.commands.flatMap(x=>x.redirects??[]);
  const classified=astRedirectsToOutputRedirections(redirects);
  assert.deepEqual(classified.redirections,[{target:'out.txt',operator:'>'}]);
  assert.deepEqual(astRedirectsToOutputRedirections([
    {op:'>>',target:'append.log'},
    {op:'&>',target:'both.log'},
    {op:'>&',target:'2'},
    {op:'<',target:'input.txt'},
  ]).redirections,[
    {target:'append.log',operator:'>>'},
    {target:'both.log',operator:'>'},
  ]);
});

test('2.1.304 input redirects preserve stream devices and ask for glob or post-cd paths',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-input-redirect-'));
  try{
    await mkdir(join(root,'subdir'));
    await writeFile(join(root,'secret.txt'),'ROOT_REDIRECT_SECRET');
    await writeFile(join(root,'subdir','secret.txt'),'POST_CD_REDIRECT_SECRET');
    const allowBash=createCliPermissionContext({
      permissionRules:{allow:[{toolName:'Bash'}],deny:[],ask:[]},
    });
    const stream=await bashToolCheckAstPermission(
      {command:'cat < /dev/null'},allowBash,{workspace:root});
    assert.equal(stream.behavior,'allow',JSON.stringify(stream));
    const sameDirectory=await bashToolCheckAstPermission(
      {command:'cat < secret.txt'},allowBash,{workspace:root});
    assert.equal(sameDirectory.behavior,'allow',JSON.stringify(sameDirectory));
    const glob=await bashToolCheckAstPermission(
      {command:'cat < secret*'},allowBash,{workspace:root});
    assert.equal(glob.behavior,'ask',JSON.stringify(glob));
    assert.equal(glob.decisionReason?.bashMissKind,'shell-expansion');
    const afterCd=await bashToolCheckAstPermission(
      {command:'cd subdir && cat < secret.txt'},allowBash,{workspace:root});
    assert.equal(afterCd.behavior,'ask',JSON.stringify(afterCd));
    assert.equal(afterCd.decisionReason?.bashMissKind,'shell-expansion');

    const readDeny=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],deny:[{toolName:'Read',ruleContent:'secret.txt'}],ask:[],
    }});
    const denied=await bashToolCheckAstPermission(
      {command:'cat < secret.txt'},readDeny,{workspace:root});
    assert.equal(denied.behavior,'deny',JSON.stringify(denied));
    assert.equal(denied.decisionReason?.type,'rule');
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test('packed CLI blocks glob and post-cd Bash input redirections before reading files',{
  timeout:85000,
},async()=>{
  const glob=await testActualCli({
    command:'cat < secret*',
    flags:['--allowedTools','Bash','--disallowedTools','Read(secret.txt)'],
    files:[['secret.txt','DO_NOT_READ_GLOB_REDIRECT']],
    shouldFail:true,
  });
  assert.doesNotMatch(JSON.stringify(glob.output),/DO_NOT_READ_GLOB_REDIRECT/);

  const afterCd=await testActualCli({
    command:'cd . && cat < secret.txt',
    flags:['--allowedTools','Bash'],
    files:[['secret.txt','DO_NOT_READ_AFTER_CD_REDIRECT']],
    shouldFail:true,
  });
  assert.doesNotMatch(JSON.stringify(afterCd.output),/DO_NOT_READ_AFTER_CD_REDIRECT/);
});

test('original Bash AST redirects apply Edit deny before shell execution and Read deny for inputs',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-bash-redirect-rules-'));
  try{
    await writeFile(join(root,'secret.txt'),'PROTECTED_INPUT');
    const denyEdit=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[{toolName:'Edit',ruleContent:'protected.txt'}],ask:[],
    }});
    for(const command of [
      'node --version > protected.txt',
      'node --version >> protected.txt',
    ]){
      const result=await bashToolCheckAstPermission({command},denyEdit,{workspace:root});
      assert.equal(result.behavior,'deny',command+JSON.stringify(result));
      assert.equal(result.decisionReason?.rule?.ruleValue?.ruleContent,'protected.txt');
      await assert.rejects(stat(join(root,'protected.txt')),{code:'ENOENT'});
    }
    const askEdit=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[],ask:[{toolName:'Edit',ruleContent:'review.txt'}],
    }});
    assert.equal((await bashToolCheckAstPermission({
      command:'node --version > review.txt',
    },askEdit,{workspace:root})).behavior,'ask');
    const safeEdit=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'node --version > safe.txt'}],
      deny:[],ask:[],
    }});
    assert.equal((await bashToolCheckAstPermission({
      command:'node --version > safe.txt',
    },safeEdit,{workspace:root})).behavior,'allow');
    assert.notEqual((await bashToolCheckAstPermission({
      command:'node --version > .git/config',
    },safeEdit,{workspace:root})).behavior,'allow');
    const scopedWrite=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'node --version > scoped.txt'},
        {toolName:'Edit',ruleContent:'scoped.txt'}],deny:[],ask:[],
    }});
    assert.equal((await bashToolCheckAstPermission({
      command:'node --version > scoped.txt',
    },scopedWrite,{workspace:root})).behavior,'allow');
    const denyRead=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[{toolName:'Read',ruleContent:'secret.txt'}],ask:[],
    }});
    const blocked=await bashToolCheckAstPermission({
      command:'cat < secret.txt',
    },denyRead,{workspace:root});
    assert.equal(blocked.behavior,'deny',JSON.stringify(blocked));
    const allowedInput=await bashToolCheckAstPermission({
      command:'cat < secret.txt',
    },createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'cat < secret.txt'}],deny:[],ask:[],
    }}),{workspace:root});
    assert.equal(allowedInput.behavior,'allow',JSON.stringify(allowedInput));
    const risky=await bashToolCheckAstPermission({
      command:'cd .claude && node --version > settings.json',
    },createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }}),{workspace:root});
    assert.notEqual(risky.behavior,'allow');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed CLI refuses Bash output redirect matching Edit(path) deny without creating file',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'node --version > protected.txt',
    flags:['--allowedTools','Bash','--disallowedTools','Edit(protected.txt)'],
    mustNotCreate:'protected.txt',shouldFail:true,
  });
  assert.match(result.output,/denied/i);
});

test('packed CLI supports scoped Read checks on AST input redirect',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:'cat < input.txt',
    flags:['--allowedTools','Bash(cat < input.txt)'],
    files:[['input.txt','BASH_INPUT_REDIRECT_VERIFIED']],
    shouldFail:false,
  });
  assert.match(result.output,/BASH_INPUT_REDIRECT_VERIFIED/);
});

test('original Bash AST treats pushd and popd as compound cwd changes before writes',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-pushd-redirect-'));
  try{
    const context=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],ask:[],deny:[],
    }});
    const pushdRedirect=await bashToolCheckAstPermission({
      command:'pushd .. && printf PUSHED_DIRECTORY_WRITE > pushd-outside.txt',
    },context,{workspace:root});
    assert.equal(pushdRedirect.behavior,'ask',JSON.stringify(pushdRedirect));
    assert.match(pushdRedirect.message,/compound command contains cd/i);

    // The pinned commandHasAnyCd() wrapper normalization also recognizes popd.
    const popdWrite=await bashToolCheckAstPermission({
      command:'time popd && touch popd-outside.txt',
    },context,{workspace:root});
    assert.equal(popdWrite.behavior,'ask',JSON.stringify(popdWrite));
    assert.match(popdWrite.message,/change directories|compound command|cd/i);

    // The source helper is also true for a single command containing a
    // directory change; keep its conservative redirect behavior unchanged.
    for(const command of [
      'pushd .. > single-pushd-output.txt',
      'time popd > single-popd-output.txt',
    ]){
      const single=await bashToolCheckAstPermission({command},context,{workspace:root});
      assert.equal(single.behavior,'ask',command+': '+JSON.stringify(single));
    }
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test('packed CLI blocks pushd-relative writes and output redirects outside the workspace',{
  timeout:85000,
},async()=>{
  const redirectMarker='agent-cil-pushd-redirect-'+process.pid+'.txt';
  const redirect=await testActualCli({
    command:'pushd .. && printf PUSHED_DIRECTORY_WRITE > '+redirectMarker,
    flags:['--allow-edits','--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'../'+redirectMarker,
  });
  assert.match(String(redirect.output),/approval|permission|requires/i);

  const writeMarker='agent-cil-pushd-write-'+process.pid+'.txt';
  const write=await testActualCli({
    command:'pushd .. && touch '+writeMarker,
    flags:['--allow-edits','--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'../'+writeMarker,
  });
  assert.match(String(write.output),/approval|permission|requires/i);
});

test('packed CLI source validatePath(create) permits safe Bash redirect only with Edit authorization',{
  timeout:35000,
},async()=>{
  const output=await testActualCli({
    command:'node --version > safe-output.txt',
    flags:['--allow-edits','--allowedTools','Bash(node --version > safe-output.txt)'],
    shouldFail:false,
    expectedWrites:[],files:[],
    // File is read inside the test helper before its cleanup using this
    // dedicated output assertion below.
    outputFilePattern:['safe-output.txt',/^v\d+/],
  });
  assert.equal(typeof output.output,'string');
});

test('packed CLI appends via original >> create path authorization without truncation',{
  timeout:35000,
},async()=>{
  await testActualCli({
    command:'node --version >> appended.txt',
    flags:['--allowedTools','Bash(node --version >> appended.txt)',
      '--allowedTools','Edit(appended.txt)'],
    files:[['appended.txt','EXISTING_PREFIX:']],
    shouldFail:false,
    outputFilePattern:['appended.txt',/^EXISTING_PREFIX:v\d+/],
  });
});

test('packed Bash source safety rejects sensitive output even with acceptEdits and exact Bash allow',{
  timeout:35000,
},async()=>{
  const blocked=await testActualCli({
    command:'node --version > .bashrc',
    flags:['--allow-edits','--allowedTools','Bash(node --version > .bashrc)'],
    shouldFail:true,mustNotCreate:'.bashrc',
  });
  assert.match(blocked.output,/approval|permission|requires/i);
});

test('original AST enforces Read deny before otherwise-allowed output redirect',{
  timeout:35000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-bash-mixed-redirect-'));
  try{
    await writeFile(join(root,'protected.txt'),'DO_NOT_EXPOSE');
    const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'cat < protected.txt > output.txt'}],
      deny:[{toolName:'Read',ruleContent:'protected.txt'}],ask:[],
    }});
    const decision=await bashToolCheckAstPermission({
      command:'cat < protected.txt > output.txt',
    },ctx,{workspace:root});
    assert.equal(decision.behavior,'deny',JSON.stringify(decision));
    assert.equal(decision.decisionReason?.rule?.ruleValue?.ruleContent,'protected.txt');
    const result=await testActualCli({
      command:'cat < protected.txt > output.txt',
      flags:['--allow-edits',
        '--allowedTools','Bash(cat < protected.txt > output.txt)',
        '--disallowedTools','Read(protected.txt)'],
      files:[['protected.txt','DO_NOT_EXPOSE']],
      shouldFail:true,mustNotCreate:'output.txt',
    });
    assert.doesNotMatch(String(result.output),/DO_NOT_EXPOSE/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('pinned BashTool.createPathChecker executes safe file operations in acceptEdits',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-bash-source-command-paths-'));
  try{
    const allow=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    for(const command of ['touch safe-created.txt','mkdir safe-dir',
      'cp existing.txt copied.txt']){
      const checked=await bashToolCheckAstPermission({command},allow,{workspace:root});
      assert.equal(checked.behavior,'allow',command+JSON.stringify(checked));
      assert.equal(checked.decisionReason?.type,'mode',
        'pinned source checkPermissionMode runs after path constraints');
    }
    const forbidden=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[{toolName:'Edit',ruleContent:'blocked.txt'}],ask:[],
    }});
    assert.equal((await bashToolCheckAstPermission({command:'touch blocked.txt'},forbidden,
      {workspace:root})).behavior,'deny');
    assert.equal((await bashToolCheckAstPermission({command:'touch .git/config'},allow,
      {workspace:root})).behavior,'ask');
    const unapproved=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:'touch no-grant.txt'}],deny:[],ask:[],
    }});
    assert.equal((await bashToolCheckAstPermission({command:'touch no-grant.txt'},unapproved,
      {workspace:root})).behavior,'ask');
    const outside=await bashToolCheckAstPermission({
      command:'touch ../escaped-from-source.txt',
    },allow,{workspace:root});
    assert.notEqual(outside.behavior,'allow',
      'source create path validation cannot grant traversal outside workspace');
    const compound=await bashToolCheckAstPermission({
      command:'cd .claude && touch settings.json',
    },allow,{workspace:root});
    assert.notEqual(compound.behavior,'allow');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('installed CLI creates authorized touch file with source path checker and blocks unsafe writes',{
  timeout:35000,
},async()=>{
  const authorized=await testActualCli({
    command:'touch created-by-source.txt',
    flags:['--allow-edits','--allowedTools','Bash(touch created-by-source.txt)'],
    shouldFail:false,
    expectedWrites:[['created-by-source.txt','']],
  });
  assert.match(String(authorized.output),/exitCode|0|stdout|stderr/);
  const denied=await testActualCli({
    command:'touch blocked-by-source.txt',
    flags:['--allow-edits','--allowedTools','Bash(touch blocked-by-source.txt)',
      '--disallowedTools','Edit(blocked-by-source.txt)'],
    mustNotCreate:'blocked-by-source.txt',shouldFail:true,
  });
  assert.match(String(denied.output),/denied/i);
});

test('pinned 2.1.88 sedValidation allowlist distinguishes read-only, in-place and w/e scripts',{
  timeout:30000,
},async()=>{
  const {sedCommandIsAllowedByAllowlist,checkSedConstraints}=await import(
    '../../runtime/src/legacy-permissions/original-bash-sed-validation.js');
  for(const command of [
    "sed -n '1p' safe.txt",
    "sed --quiet '1,3p' safe.txt",
    "sed -n '1p;3p' safe.txt",
  ]){
    assert.equal(sedCommandIsAllowedByAllowlist(command),true,command);
    assert.equal(checkSedConstraints(command,{mode:'default'}).behavior,'passthrough');
  }
  for(const command of [
    "sed -i 's/a/b/g' safe.txt",
    "sed -n 'w outside.txt' safe.txt",
    "sed -n 'e id' safe.txt",
    "sed -n '1,3w dangerous.txt' safe.txt",
    "sed -f sed.script safe.txt",
    "sed -n 's/a/b/w dangerous.txt' safe.txt",
  ]){
    assert.equal(sedCommandIsAllowedByAllowlist(command),false,command);
    assert.equal(checkSedConstraints(command,{mode:'default'}).behavior,'ask',command);
  }
  assert.equal(sedCommandIsAllowedByAllowlist("sed -i 's/a/b/g' safe.txt",
    {allowFileWrites:true}),true,'source acceptEdits -i substitution allowance');
  assert.equal(checkSedConstraints("sed -i 's/a/b/g' safe.txt",
    {mode:'acceptEdits'}).behavior,'passthrough');
  assert.equal(checkSedConstraints("sed -i 's/a/b/w dangerous.txt' safe.txt",
    {mode:'acceptEdits'}).behavior,'ask');
});

test('real Bash AST source sed override enforces Read(path) rather than Edit(path) for -n print',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-original-sed-paths-'));
  try{
    await writeFile(join(root,'safe.txt'),'LINE_1\nLINE_2\n');
    const ctx=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:"sed -n '1p' safe.txt"}],
      deny:[{toolName:'Edit',ruleContent:'safe.txt'}],ask:[],
    }});
    const permitted=await bashToolCheckAstPermission(
      {command:"sed -n '1p' safe.txt"},ctx,{workspace:root});
    assert.equal(permitted.behavior,'allow',JSON.stringify(permitted));
    const restrictive=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash',ruleContent:"sed -n '1p' safe.txt"}],
      deny:[{toolName:'Read',ruleContent:'safe.txt'}],ask:[],
    }});
    const forbidden=await bashToolCheckAstPermission(
      {command:"sed -n '1p' safe.txt"},restrictive,{workspace:root});
    assert.equal(forbidden.behavior,'deny',JSON.stringify(forbidden));
    assert.equal(forbidden.decisionReason?.rule?.ruleValue?.ruleContent,'safe.txt');
    const protectedTarget=await bashToolCheckAstPermission({
      command:"sed -i 's/a/b/g' .bashrc",
    },createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }}),{workspace:root});
    assert.equal(protectedTarget.behavior,'ask',
      'Original path safety must beat sed -i read/write allowance');
    for(const command of ["sed -i 's/a/b/g' safe.txt",
      "sed -n 'w unsafe.txt' safe.txt",
      "sed -n 'e id' safe.txt"]){
      const broad=createCliPermissionContext({allowEdits:true,permissionRules:{
        allow:[{toolName:'Bash'}],deny:[],ask:[],
      }});
      const outcome=await bashToolCheckAstPermission({command},broad,{workspace:root});
      // acceptEdits explicitly authorizes -i pattern-2, but not w/e.
      assert.equal(outcome.behavior,command.includes("'s/a/b/g'")?'allow':'ask',
        command+JSON.stringify(outcome));
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

if(process.platform!=='win32'){
  test('installed CLI executes original sed -n read-only and preserves source file bytes',{
    timeout:35000,
  },async()=>{
    const cmd="sed -n '1p' safe.txt";
    const safe=await testActualCli({command:cmd,
      flags:['--allowedTools',"Bash("+cmd+")"],
      files:[['safe.txt','SED_LINE_ONE\nSED_LINE_TWO\n']],
      shouldFail:false,
      expectedWrites:[['safe.txt','SED_LINE_ONE\nSED_LINE_TWO\n']],
    });
    assert.match(safe.output,/SED_LINE_ONE/);
    const denied=await testActualCli({command:cmd,
      flags:['--allowedTools',"Bash("+cmd+")",
        '--disallowedTools','Read(safe.txt)'],
      files:[['safe.txt','SENSITIVE_SED_LINE\n']],
      shouldFail:true,
      expectedWrites:[['safe.txt','SENSITIVE_SED_LINE\n']],
    });
    assert.doesNotMatch(String(denied.output),/SENSITIVE_SED_LINE/);
  });
}
test('packed CLI never executes sed write/execute script despite Bash whole allow',{
  timeout:35000,
},async()=>{
  const cmd="sed -n 'w forbidden.txt' input.txt";
  const result=await testActualCli({command:cmd,
    flags:['--allowedTools','Bash','--allow-edits'],
    files:[['input.txt','HELLO\n']],
    shouldFail:true,mustNotCreate:'forbidden.txt',
  });
  assert.match(String(result.output),/approval|permission/i);
});

if(process.platform!=='win32'){
  test('packed sed -i actually edits safe file in acceptEdits and preserves denied file in default',{
    timeout:35000,
  },async()=>{
    const command="sed -i 's/OLD/NEW/' source.txt";
    const flags=['--allowedTools',"Bash("+command+")"];
    const denied=await testActualCli({
      command,flags,
      files:[['source.txt','ORIGINAL_OLD_VALUE\n']],
      shouldFail:true,
      expectedWrites:[['source.txt','ORIGINAL_OLD_VALUE\n']],
    });
    assert.match(String(denied.output),/approval|permission/i);
    const allowed=await testActualCli({
      command,flags:['--allow-edits',...flags],
      files:[['source.txt','ORIGINAL_OLD_VALUE\n']],
      shouldFail:false,
      expectedWrites:[['source.txt','ORIGINAL_NEW_VALUE\n']],
    });
    assert.equal(typeof allowed.output,'string');
    const protectedFile=await testActualCli({
      command:"sed -i 's/OLD/NEW/' .bashrc",
      flags:['--allow-edits','--allowedTools',
        "Bash(sed -i 's/OLD/NEW/' .bashrc)"],
      files:[['.bashrc','PROTECTED_OLD_VALUE\n']],
      shouldFail:true,
      expectedWrites:[['.bashrc','PROTECTED_OLD_VALUE\n']],
    });
    assert.match(String(protectedFile.output),/approval|permission/i);
  });
}

test('source 2.1.88 internal path checks fail closed without verified session ownership',{
  timeout:30000,
},async()=>{
  const {checkReadableInternalPath,checkEditableInternalPath}=await import(
    '../../runtime/src/legacy-permissions/original-internal-paths.js');
  const root=await mkdtemp(join(tmpdir(),'agent-cil-internal-source-'));
  const sid='11111111-1111-4111-8111-111111111111';
  try{
    const foreignSid='22222222-2222-4222-8222-222222222222';
    const current=join(root,'.agent-cil','sessions',sid,'tool-results','output.txt');
    const foreign=join(root,'.agent-cil','sessions',foreignSid,'tool-results','output.txt');
    const deniedPaths=[
      join(root,'.claude','launch.json'),
      join(root,'.claude','settings.json'),
      join(root,'.claude','plans','plan.md'),
      join(root,'.claude','agents','agent.md'),
      foreign,
      join(tmpdir(),'claude-unowned','scratchpad','file.txt'),
      join(tmpdir(),'claude-unowned','bundled-skills','fake','content.txt'),
    ];
    const ctx={workspace:root,sessionId:sid};
    assert.equal(checkReadableInternalPath(current,{},ctx).behavior,'allow',
      'only locked-session persisted tool-result root has native provenance');
    assert.equal(checkReadableInternalPath(current,{},{
      workspace:root,sessionId:foreignSid,
    }).behavior,'passthrough');
    for(const p of deniedPaths){
      assert.equal(checkEditableInternalPath(p,{},ctx).behavior,'passthrough',
        'missing original write-ownership provider must never silently allow '+p);
      assert.equal(checkReadableInternalPath(p,{},ctx).behavior,'passthrough',
        'missing original read-ownership provider must never silently allow '+p);
    }
    assert.equal(checkEditableInternalPath(current,{},ctx).behavior,'passthrough');
    assert.equal(checkReadableInternalPath(current,{},{
      workspace:root,sessionId:'fake-session',
    }).behavior,'passthrough');
    assert.equal(checkReadableInternalPath(join(root,'../different.txt'),{},ctx).behavior,
      'passthrough');
    // Even a trusted TaskOutput callback cannot grant a file from another
    // session; its native implementation matches a *completed* record.
    assert.equal(checkReadableInternalPath(foreign,{},{
      workspace:root,sessionId:sid,verifiedCompletedTaskOutput:()=>false,
    }).behavior,'passthrough');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('source 2.1.88 acceptEdits checkPermissionMode retains filesystem verbs and default mode',async()=>{
  const {checkPermissionMode,validateCommandForMode,ACCEPT_EDITS_ALLOWED_COMMANDS}=
    await import('../../runtime/src/legacy-permissions/original-bash-mode-validation.js');
  assert.deepEqual(ACCEPT_EDITS_ALLOWED_COMMANDS,
    ['mkdir','touch','rm','rmdir','mv','cp','sed']);
  const approved=createCliPermissionContext({allowEdits:true});
  const standard=createCliPermissionContext();
  for(const command of ['touch test.txt','mkdir testdir','cp one two','mv one two',
    'rm old.txt','rmdir old','sed -i "s/a/b/" src.txt']){
    assert.equal(validateCommandForMode(command,approved).behavior,'allow',command);
    assert.equal(checkPermissionMode({command},approved,[command]).behavior,'allow',command);
    assert.equal(checkPermissionMode({command},standard,[command]).behavior,'passthrough',command);
  }
  assert.equal(checkPermissionMode({command:'node --version'},approved,
    ['node --version']).behavior,'passthrough');
});

test('original Bash mode auto-allows only source-validated safe paths',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-original-mode-source-'));
  try{
    await writeFile(join(root,'old.txt'),'ORIGINAL');
    const normal=createCliPermissionContext({allowEdits:true});
    for(const command of ['touch new-file.txt','mkdir new-dir','cp old.txt copy.txt']){
      const result=await bashToolCheckAstPermission({command},normal,{workspace:root});
      assert.equal(result.behavior,'allow',command+JSON.stringify(result));
      assert.equal(result.decisionReason?.type,'mode');
    }
    const deny=createCliPermissionContext({allowEdits:true,permissionRules:{
      deny:[{toolName:'Edit',ruleContent:'locked.txt'}],allow:[],ask:[],
    }});
    assert.equal((await bashToolCheckAstPermission({command:'touch locked.txt'},
      deny,{workspace:root})).behavior,'deny');
    const ask=createCliPermissionContext({allowEdits:true,permissionRules:{
      ask:[{toolName:'Edit',ruleContent:'review.txt'}],allow:[],deny:[],
    }});
    assert.equal((await bashToolCheckAstPermission({command:'touch review.txt'},
      ask,{workspace:root})).behavior,'ask');
    assert.notEqual((await bashToolCheckAstPermission({
      command:'touch .bashrc'
    },normal,{workspace:root})).behavior,'allow');
    assert.equal((await bashToolCheckAstPermission({
      command:"sed -n 'w unsafe.txt' old.txt"
    },normal,{workspace:root})).behavior,'ask');
    assert.notEqual((await bashToolCheckAstPermission({command:'touch new-file.txt'},
      createCliPermissionContext(),{workspace:root})).behavior,'allow');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('2.1.304 extra glob path arguments are checked even when the old extractor misses them',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-newer-glob-path-'));
  try{
    const allowed=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    // The 2.1.88 Git extractor only returns paths for diff --no-index.
    // The 2.1.304 path checker also validates shell-expanded glob argv values
    // that the command-specific extractor misses. This operand is unquoted,
    // so its original AST provenance must cause a scoped Read-path check.
    const checked=await bashToolCheckAstPermission({
      command:'git diff HEAD -- /etc/*.conf',
    },allowed,{workspace:root});
    assert.equal(checked.behavior,'ask',JSON.stringify(checked));
    assert.match(checked.message,/allowed working directories|Path|path/i);
    assert.match(String(checked.blockedPath),/etc/i);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed acceptEdits Bash creates actual file without explicit Bash allow rule',{
  timeout:35000,
},async()=>{
  await testActualCli({command:'touch created-by-mode.txt',
    flags:['--allow-edits'],shouldFail:false,
    expectedWrites:[['created-by-mode.txt','']]});
  const forbidden=await testActualCli({command:'touch denied-by-mode.txt',
    flags:['--allow-edits','--disallowedTools','Edit(denied-by-mode.txt)'],
    mustNotCreate:'denied-by-mode.txt',shouldFail:true});
  assert.match(String(forbidden.output),/denied/i);
});
if(process.platform!=='win32'){
  test('packed acceptEdits sed -i changes disk without Bash command allow',{
    timeout:35000,
  },async()=>{
    await testActualCli({
      command:"sed -i 's/OLD/NEW/' mode-input.txt",
      flags:['--allow-edits'],
      files:[['mode-input.txt','MODE_OLD_VALUE\n']],
      shouldFail:false,
      expectedWrites:[['mode-input.txt','MODE_NEW_VALUE\n']],
    });
  });
}

test('installed CLI explicit whole Bash deny outranks acceptEdits filesystem auto-allow',{
  timeout:35000,
},async()=>{
  const blocked=await testActualCli({
    command:'touch whole-tool-denied.txt',
    flags:['--allow-edits','--disallowedTools','Bash'],
    mustNotCreate:'whole-tool-denied.txt',shouldFail:true,
  });
  assert.match(String(blocked.output),/denied|permission/i);
});

test('source 2.1.88 original regex branch allows safe read-only versions, rejects execution flags and expansions',async()=>{
  const {checkOriginalReadOnlyRegexBranch,isCommandReadOnly,containsUnquotedExpansion}=
    await import('../../runtime/src/legacy-permissions/original-bash-readonly-regex.js');
  for(const command of ['pwd','whoami','node --version','node -v','python3 --version',
    'echo readable','ls .','cat safe.txt']){
    const d=checkOriginalReadOnlyRegexBranch(command);
    assert.equal(d.behavior,'allow',command+JSON.stringify(d));
    assert.equal(d.decisionReason?.reason,'Read-only command is allowed');
  }
  for(const command of ['node -v --run dangerous','node --version --eval evil',
    'ls *','ls "$HOME"','echo "$PATH"','echo $(id)','cat ../*',
    'sed -i "s/a/b/" x.txt','git -c core.fsmonitor=evil status']){
    assert.equal(checkOriginalReadOnlyRegexBranch(command).behavior,'passthrough',command);
  }
  assert.equal(containsUnquotedExpansion("ls '*'"),false);
  assert.equal(containsUnquotedExpansion("ls *"),true);
  assert.equal(isCommandReadOnly('node --version'),true);
});

test('source regex readonly bridge preserves explicit Bash deny, Read(path) deny and unknown commands',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-source-readonly-'));
  try{
    await writeFile(join(root,'safe.txt'),'SOURCE_READ_ONLY_TOKEN');
    const normal=createCliPermissionContext();
    for(const command of ['pwd','whoami','node --version','cat safe.txt']){
      const result=await bashToolCheckAstPermission({command},normal,{workspace:root});
      assert.equal(result.behavior,'allow',command+JSON.stringify(result));
    }
    const deny=createCliPermissionContext({permissionRules:{
      allow:[],ask:[],deny:[{toolName:'Bash',ruleContent:'node --version'}],
    }});
    assert.equal((await bashToolCheckAstPermission({
      command:'node --version'},deny,{workspace:root})).behavior,'deny');
    const readDeny=createCliPermissionContext({permissionRules:{
      allow:[],ask:[],deny:[{toolName:'Read',ruleContent:'safe.txt'}],
    }});
    assert.equal((await bashToolCheckAstPermission({
      command:'cat safe.txt'},readDeny,{workspace:root})).behavior,'deny');
    assert.notEqual((await bashToolCheckAstPermission({
      command:'node -v --run dangerous'},normal,{workspace:root})).behavior,'allow');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed original regex read-only Bash executes node --version without Bash allow rule',{
  timeout:35000,
},async()=>{
  const completed=await testActualCli({
    command:'node --version',flags:[],shouldFail:false,
  });
  assert.match(completed.output,/v[0-9]+/);
  const denied=await testActualCli({
    command:'node --version',flags:['--disallowedTools','Bash(node --version)'],
    shouldFail:true,
  });
  assert.match(denied.output,/denied/i);
});

test('source shellQuote parser differential cannot be re-approved by Bash readonly regex or acceptEdits mode',{
  timeout:30000,
},async()=>{
  const {hasShellQuoteSingleQuoteBug}=await import(
    '../../runtime/src/legacy-permissions/bash-shell-quote.js');
  const root=await mkdtemp(join(tmpdir(),'agent-shellquote-readonly-'));
  try{
    const suspicious="cat 'safe\\' '--squeeze-blank'";
    assert.equal(hasShellQuoteSingleQuoteBug(suspicious),true,
      'original shell-quote differential is real for the chosen source fixture');
    for(const context of [createCliPermissionContext(),
      createCliPermissionContext({allowEdits:true})]){
      const result=await bashToolCheckAstPermission({command:suspicious},
        context,{workspace:root});
      assert.equal(result.behavior,'ask',JSON.stringify(result));
      assert.equal(result.decisionReason?.reason,'Original shellQuote security validation');
    }
    const unrelatedRestriction=createCliPermissionContext({allowEdits:true,permissionRules:{
      deny:[{toolName:'Bash',ruleContent:'node:*'}],ask:[],allow:[],
    }});
    const restricted=await bashToolCheckAstPermission({command:'touch content-restricted.txt'},
      unrelatedRestriction,{workspace:root});
    assert.equal(restricted.behavior,'allow',JSON.stringify(restricted));
    assert.equal(restricted.updatedInput.command,'touch content-restricted.txt',
      'the pinned original matcher evaluates the verified leaf, not unrelated deny rules');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('pinned original full validateFlags retains GNU getopt and xargs anti-smuggling',{
  timeout:30000,
},async()=>{
  const {isCommandSafeViaFlagParsing,validateFlags,COMMAND_ALLOWLIST,
    GIT_READ_ONLY_COMMANDS,RIPGREP_READ_ONLY_COMMANDS}=await import(
      '../../runtime/src/legacy-permissions/original-bash-readonly-flags.js');
  assert.ok(GIT_READ_ONLY_COMMANDS['git status']);
  assert.ok(RIPGREP_READ_ONLY_COMMANDS.rg);
  for(const command of [
    'sort -r safe.txt','sort --reverse safe.txt',
    'grep -n TODO safe.txt','grep -A2 TODO safe.txt',
    'rg --line-number TODO safe.txt','git status --short',
    'git diff --stat'
  ])assert.equal(isCommandSafeViaFlagParsing(command),true,command);
  for(const command of [
    'sort --output=unsafe.txt safe.txt','sort -o unsafe.txt safe.txt',
    'rg --pre=bash TODO safe.txt','git diff --output=unsafe',
    'git ls-remote https://malicious.example/repo',
    'git -c core.fsmonitor=evil status',
    'rg TODO "$Z--pre=bash" safe.txt',
    'sort {1,2} safe.txt','xargs -rI echo sh -c id',
    'xargs -E= EOF echo foo'
  ])assert.equal(isCommandSafeViaFlagParsing(command),false,command);
  assert.equal(validateFlags(['-r','--reverse'],0,COMMAND_ALLOWLIST.sort),true);
  assert.equal(validateFlags(['--output=unsafe'],0,COMMAND_ALLOWLIST.sort),false);
});

test('real original Bash read-only flag parser auto-allows safe sort but not output write or unverified git',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-original-full-flags-'));
  try{
    await writeFile(join(root,'safe.txt'),'Z\nA\n');
    const context=createCliPermissionContext();
    const safe=await bashToolCheckAstPermission({
      command:'sort -r safe.txt'},context,{workspace:root});
    assert.equal(safe.behavior,process.platform==='win32'?'passthrough':'allow',
      JSON.stringify(safe));
    assert.notEqual((await bashToolCheckAstPermission({
      command:'sort --output=unsafe.txt safe.txt'},context,{workspace:root})).behavior,'allow');
    assert.equal((await bashToolCheckAstPermission({
      command:'git status --short'},context,{workspace:root})).behavior,
      process.platform==='win32'?'passthrough':'allow');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed CLI source read-only flags executes actual sort and refuses write flag',{
  timeout:35000,
},async()=>{
  if(process.platform!=='win32'){
    const allowed=await testActualCli({
      command:'sort -r safe.txt',flags:[],shouldFail:false,
      files:[['safe.txt','A\nZ\n']],
      expectedWrites:[['safe.txt','A\nZ\n']],
    });
    assert.match(allowed.output,/Z/);
  } else {
    // Windows cmd.exe uses Windows sort.exe, not GNU sort. Auto-approval
    // from a POSIX flag parser would run the wrong binary semantics.
    const blocked=await testActualCli({
      command:'sort -r safe.txt',flags:[],shouldFail:true,
      files:[['safe.txt','A\nZ\n']],
      expectedWrites:[['safe.txt','A\nZ\n']],
    });
    assert.match(String(blocked.output),/approval|permission/i);
  }
  const denied=await testActualCli({
    command:'sort --output=forbidden.txt safe.txt',
    flags:[],shouldFail:true,
    files:[['safe.txt','TEST\n']],
    mustNotCreate:'forbidden.txt',
  });
  assert.match(String(denied.output),/approval|permission/i);
});

test('pinned git.ts bare-repository detection and actual read-only git permissions',{
  timeout:30000,
},async()=>{
  const {isCurrentDirectoryBareGitRepo}=await import(
    '../../runtime/src/legacy-permissions/original-bash-bare-git.js');
  const {checkOriginalReadOnlyRegexBranch}=await import(
    '../../runtime/src/legacy-permissions/original-bash-readonly-regex.js');
  const ctx=createCliPermissionContext();
  const cmd='git status --short';
  for(const indicator of ['HEAD','objects','refs']){
    const root=await mkdtemp(join(tmpdir(),'agent-bare-repo-source-'));
    try{
      if(indicator==='HEAD')
        await writeFile(join(root,'HEAD'),'ref: refs/heads/main\n');
      else await mkdir(join(root,indicator));
      assert.equal(isCurrentDirectoryBareGitRepo(root),true,
        'original git.ts bare indicator '+indicator);
      const decision=await bashToolCheckAstPermission({command:cmd},ctx,{workspace:root});
      assert.notEqual(decision.behavior,'allow',JSON.stringify(decision));
      assert.equal(checkOriginalReadOnlyRegexBranch(cmd,{
        workspace:root,originalCwd:root,sandboxEnabled:false,
      }).behavior,'passthrough');
    }finally{await rm(root,{recursive:true,force:true})}
  }
  const normal=await mkdtemp(join(tmpdir(),'agent-normal-repo-source-'));
  try{
    await mkdir(join(normal,'.git'));
    await writeFile(join(normal,'.git','HEAD'),'ref: refs/heads/main\n');
    assert.equal(isCurrentDirectoryBareGitRepo(normal),false);
    assert.equal(checkOriginalReadOnlyRegexBranch(cmd).behavior,'passthrough',
      'unverified workspace must not automatically permit git');
    assert.equal(checkOriginalReadOnlyRegexBranch(cmd,{
      workspace:normal,originalCwd:normal,sandboxEnabled:true,
    }).behavior,'passthrough','unverified sandbox cannot grant git');
    assert.equal(checkOriginalReadOnlyRegexBranch(cmd,{
      workspace:normal,originalCwd:join(normal,'nested'),sandboxEnabled:false,
    }).behavior,'passthrough','mismatched cwd cannot grant git');
    const decision=await bashToolCheckAstPermission({command:cmd},ctx,{workspace:normal});
    assert.equal(decision.behavior,
      process.platform==='win32'?'passthrough':'allow',JSON.stringify(decision));
  }finally{await rm(normal,{recursive:true,force:true})}
});

test('packed CLI real Git status auto-allows normal repo, denies bare and explicit disallow',{
  timeout:35000,
},async()=>{
  const setup=root=>execFileSync('git',['init','-q'],{cwd:root,stdio:'ignore'});
  if(process.platform==='win32'){
    const blocked=await testActualCli({command:'git status --short',
      flags:[],shouldFail:true,setup});
    assert.match(String(blocked.output),/permission|approval/i);
    return;
  }
  const good=await testActualCli({command:'git status --short',
    flags:[],shouldFail:false,setup});
  assert.equal(typeof good.output,'string');
  const denied=await testActualCli({command:'git status --short',
    flags:['--disallowedTools','Bash(git status --short)'],
    shouldFail:true,setup});
  assert.match(String(denied.output),/denied/i);
  const bare=await testActualCli({command:'git status --short',
    flags:[],shouldFail:true,
    setup:async root=>{
      await mkdir(join(root,'objects'));
      await writeFile(join(root,'HEAD'),'ref: refs/heads/main\n');
    }});
  assert.match(String(bare.output),/permission|approval/i);
});

test('source 2.1.88 normalized Git/cd and internal path extraction use AST command leaves',{
  timeout:30000,
},async()=>{
  const {isNormalizedGitCommand,isNormalizedCdCommand,isGitInternalPath,
    extractWritePathsFromSubcommand,commandWritesToGitInternalPaths,
    checkOriginalCompoundReadOnlyConstraints}=await import(
      '../../runtime/src/legacy-permissions/original-bash-readonly-compound.js');
  assert.equal(isNormalizedGitCommand('git status'),true);
  assert.equal(isNormalizedGitCommand('FORCE_COLOR=1 git status'),true);
  assert.equal(isNormalizedGitCommand('env FOO=1 git status'),false,
    'the original source does not strip arbitrary env command wrappers');
  assert.equal(isNormalizedGitCommand('xargs git status'),true);
  assert.equal(isNormalizedCdCommand('FORCE_COLOR=1 cd ./repo'),true);
  assert.equal(isNormalizedCdCommand('env KEY=ok cd ./repo'),false,
    'source only strips trusted shell-level env assignments');
  assert.equal(isNormalizedCdCommand('pushd ./repo'),true);
  assert.equal(isGitInternalPath('hooks/pre-commit'),true);
  assert.equal(isGitInternalPath('refs/heads/main'),true);
  assert.equal(isGitInternalPath('src/index.js'),false);
  assert.deepEqual(extractWritePathsFromSubcommand('touch hooks/pre-commit'),
    ['hooks/pre-commit']);
  const malicious=await parseOriginalBashForSecurity(
    'mkdir -p hooks && touch hooks/pre-commit && git status');
  assert.equal(malicious.kind,'simple',JSON.stringify(malicious));
  assert.equal(commandWritesToGitInternalPaths(
    'mkdir -p hooks && touch hooks/pre-commit && git status',
    malicious.commands),true);
  const redirects=await parseOriginalBashForSecurity(
    "echo unsafe > hooks/pre-commit && git status");
  assert.equal(redirects.kind,'simple',JSON.stringify(redirects));
  assert.equal(commandWritesToGitInternalPaths(
    "echo unsafe > hooks/pre-commit && git status",redirects.commands),true);
  const safety=checkOriginalCompoundReadOnlyConstraints(
    {command:'cd sub && git status'},[
      {text:'cd sub',argv:['cd','sub'],redirects:[]},
      {text:'git status',argv:['git','status'],redirects:[]},
    ],{workspace:process.cwd(),originalCwd:process.cwd(),sandboxEnabled:false});
  assert.equal(safety.behavior,'passthrough');
  assert.match(safety.message,/cd and git|Windows cmd/);
});

test('original AST permits only fully source-validated read-only Bash compounds',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-readonly-compound-source-'));
  try{
    await writeFile(join(root,'safe.txt'),'COMPOUND_READ_ONLY');
    const context=createCliPermissionContext();
    const safe=await bashToolCheckAstPermission({
      command:'pwd && whoami'},context,{workspace:root});
    assert.equal(safe.behavior,'allow',JSON.stringify(safe));
    const piped=await bashToolCheckAstPermission({
      command:'cat safe.txt | wc -l'},context,{workspace:root});
    assert.equal(piped.behavior,'allow',JSON.stringify(piped));
    for(const command of [
      'cd /tmp && git status',
      'touch hooks/pre-commit && git status',
      'pwd && node -v --run dangerous',
    ]){
      const r=await bashToolCheckAstPermission({command},context,{workspace:root});
      assert.notEqual(r.behavior,'allow',command+JSON.stringify(r));
    }
    const denied=createCliPermissionContext({permissionRules:{
      deny:[{toolName:'Bash',ruleContent:'whoami'}],allow:[],ask:[],
    }});
    const result=await bashToolCheckAstPermission({
      command:'pwd && whoami'},denied,{workspace:root});
    assert.equal(result.behavior,'deny',JSON.stringify(result));
  }finally{await rm(root,{recursive:true,force:true})}
});

test('real packed CLI executes safe source read-only compound without explicit Bash allow',{
  timeout:35000,
},async()=>{
  // POSIX and Windows now run the same source-validated read-only gate:
  // Windows launches the registered Git Bash binary under the Job Object,
  // not cmd.exe. This is a real packed CLI + SSE + authenticated Bash result.
  const actual=await testActualCli({
    command:'node --version && whoami',flags:[],shouldFail:false,
  });
  assert.match(actual.output,/v[0-9]+/);
  const denied=await testActualCli({
    command:'node --version && whoami',
    flags:['--disallowedTools','Bash(whoami)'],shouldFail:true,
  });
  assert.match(String(denied.output),/denied/i);
});

test('pinned 2.1.88 bashSecurity misparsing validators retain source boundary semantics',async()=>{
  const {checkOriginalBashMisparsingSafety,validateCarriageReturn,
    validateQuotedNewline,validateUnicodeWhitespace,
    hasBackslashEscapedOperator,hasBackslashEscapedWhitespace}=await import(
      '../../runtime/src/legacy-permissions/original-bash-safety-prefilter.js');
  for(const command of [
    'echo safe'+String.fromCharCode(0)+'unsafe',
    'echo safe'+String.fromCharCode(127)+'unsafe',
    'node --version\r --run malware',
    'echo safe\u00a0unsafe',
    'echo\\ unsafe',
    'echo safe \\; cat secret',
    'echo safe # \'quote',
    "echo 'first\n# hidden-argument\nlast'",
  ]){
    const result=checkOriginalBashMisparsingSafety(command);
    assert.equal(result.behavior,'ask',JSON.stringify({command,result}));
    assert.equal(result.isBashSecurityCheckForMisparsing,true);
  }
  for(const command of [
    'node --version',
    'echo "inside quotes; harmless"',
    "echo 'single quoted\\; literal'",
    "echo 'line1\nline2'",
    'echo "CR inside double quote \r harmless"',
  ]){
    assert.equal(checkOriginalBashMisparsingSafety(command).behavior,
      'passthrough',command);
  }
  assert.equal(validateCarriageReturn({
    originalCommand:'echo "quoted\rline"'
  }).behavior,'passthrough');
  assert.equal(validateQuotedNewline({
    originalCommand:"echo 'line1\n# danger'"
  }).behavior,'ask');
  assert.equal(validateUnicodeWhitespace({
    originalCommand:'echo text\u200b'
  }).behavior,'passthrough','source only flags its enumerated Unicode whitespace');
  assert.equal(hasBackslashEscapedOperator("echo '\\;'"),false);
  assert.equal(hasBackslashEscapedWhitespace('echo\\ word'),true);
});

test('2.1.88 Bash misparsing checks outrank acceptEdits and exact Bash allow',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-bash-security-source-'));
  try{
    const unsafe=[
      'touch unsafe.txt'+String.fromCharCode(0),
      'touch unsafe.txt\r',
      'touch unsafe\\ path.txt',
      "touch 'safe\n#hidden\nfile' other.txt",
    ];
    const allowed=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],ask:[],deny:[],
    }});
    for(const command of unsafe){
      const result=await bashToolCheckAstPermission({command},allowed,{workspace:root});
      assert.notEqual(result.behavior,'allow',JSON.stringify({command,result}));
    }
    const deny=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[{toolName:'Bash',ruleContent:'touch unsafe.txt'}],ask:[],
    }});
    const result=await bashToolCheckAstPermission({
      command:'touch unsafe.txt'+String.fromCharCode(0),
    },deny,{workspace:root});
    assert.notEqual(result.behavior,'allow');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed CLI rejects source quoted-newline hidden path under acceptEdits before file write',{
  timeout:35000,
},async()=>{
  const r=await testActualCli({
    command:"touch harmless.txt 'first\n# hiding.txt\nend'",
    flags:['--allow-edits','--allowedTools','Bash'],
    shouldFail:true,mustNotCreate:'harmless.txt',
  });
  assert.match(String(r.output),/quoted newline|approval|permission/i);
});

test('2.1.88 Bash quote-aware brace/IFS/proc/hash validators preserve original contracts',async()=>{
  const {checkOriginalBashFurtherMisparsing,extractQuotedContent,
    validateBraceExpansion,validateIFSInjection,validateProcEnvironAccess,
    validateMidWordHash,validateMalformedTokenInjection}=await import(
    '../../runtime/src/legacy-permissions/original-bash-safety-further.js');
  for(const [command,pattern] of [
    ['echo $IFS',/IFS variable/],
    ['cat /proc/self/environ',/proc/],
    ['echo {safe,unsafe}',/brace expansion/],
    ['git diff {@\'{\'0},--output=/tmp/pwned}',/brace/],
    ['echo foo#bar',/mid-word #/],
    ['echo $HOME | cat',/variables in dangerous contexts/],
  ]){
    const r=checkOriginalBashFurtherMisparsing(command);
    assert.equal(r.behavior,'ask',JSON.stringify({command,r}));
    assert.match(r.message,pattern);
    assert.equal(r.isBashSecurityCheckForMisparsing,true);
  }
  for(const cmd of ['node --version',"echo '{a,b}'",'echo "{a,b}"','echo {unclosed']){
    assert.equal(checkOriginalBashFurtherMisparsing(cmd).behavior,'passthrough',cmd);
  }
  const view=extractQuotedContent("echo '{a,b}' \"{c,d}\" {e,f}");
  assert.equal(view.fullyUnquoted,'echo   {e,f}');
  assert.equal(validateBraceExpansion({originalCommand:"echo '{a,b}'",
    fullyUnquotedPreStrip:'echo  '}).behavior,'passthrough');
  assert.equal(validateIFSInjection({originalCommand:'echo $IFS'}).behavior,'ask');
  assert.equal(validateProcEnvironAccess({
    originalCommand:'cat /proc/self/environ'}).behavior,'ask');
  assert.equal(validateMidWordHash({unquotedKeepQuoteChars:'echo word#comment'}).behavior,'ask');
  assert.equal(validateMalformedTokenInjection({
    originalCommand:'node --version'}).behavior,'passthrough');
});

test('original IFS, brace and proc checks outrank acceptEdits and Bash whole-tool allows',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-bash-further-'));
  try{
    const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    for(const command of [
      'touch guarded.txt {a,b}',
      'touch guarded.txt $IFS',
      'cat /proc/self/environ',
      'echo safe#hidden',
    ]){
      const result=await bashToolCheckAstPermission({command},ctx,{workspace:root});
      assert.equal(result.behavior,'ask',JSON.stringify({command,result}));
      assert.equal(result.decisionReason?.type,'safetyCheck');
    }
    await assert.rejects(stat(join(root,'guarded.txt')),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed CLI original brace preflight blocks acceptEdits and whole Bash allow',{
  timeout:35000,
},async()=>{
  const r=await testActualCli({
    command:'touch guarded.txt {first,second}',
    flags:['--allow-edits','--allowedTools','Bash'],
    shouldFail:true,mustNotCreate:'guarded.txt',
  });
  // The real --print CLI intentionally returns a generic interactive
  // approval denial, without exposing its internal safety-check reason
  // to the model. The source/AST tests above assert the specific brace
  // decision, while this packed test proves no filesystem mutation.
  assert.match(String(r.output),/approval|permission|denied/i);
});

test('original 2.1.88 obfuscated flag full source detects quote-joined parameter smuggling',{
  timeout:30000,
},async()=>{
  const {checkOriginalBashFlagObfuscation,validateObfuscatedFlags,
    checkOriginalZshDangerousCommands}=await import(
    '../../runtime/src/legacy-permissions/original-bash-obfuscated-flags.js');
  for(const command of [
    "find . -name $'-exec'",
    'jq $"-f" source.json',
    "find . ''-exec command",
    'jq """-f" program.jq',
    'find . "-""exec" echo',
    'jq -f"ile" input.json',
    'fc -e vi',
    'zmodload zsh/system',
    'FOO=bar command builtin zmodload zsh/system',
    'noglob zpty -b',
    'emulate -c script',
  ]){
    const result=/^(?:fc|zmodload|FOO=bar|noglob|emulate)/.test(command)
      ?checkOriginalZshDangerousCommands(command)
      :checkOriginalBashFlagObfuscation(command);
    assert.equal(result.behavior,'ask',JSON.stringify({command,result}));
    assert.equal(result.isBashSecurityCheckForMisparsing,true);
  }
  for(const command of [
    'node --version','jq . source.json','grep -n sample safe.txt',
    'echo "quoted -f harmless"','echo $\'-x\'',
  ]){
    const result=checkOriginalBashFlagObfuscation(command);
    assert.equal(result.behavior,'passthrough',JSON.stringify({command,result}));
  }
  assert.equal(validateObfuscatedFlags({
    originalCommand:'jq "-"exec input.json',baseCommand:'jq',
    fullyUnquotedContent:'jq exec input.json',
  }).behavior,'ask');
});

test('original Bash quote-obfuscation/Zsh prechecks precede all allow and edit modes',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-obfuscated-source-'));
  try{
    const wholeAllow=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    for(const command of [
      "touch guarded.txt $'-a'",
      'touch guarded.txt ""-x',
      'zmodload zsh/system',
      'fc -e vi',
    ]){
      const result=await bashToolCheckAstPermission({
        command},wholeAllow,{workspace:root});
      assert.equal(result.behavior,'ask',JSON.stringify({command,result}));
      assert.equal(result.decisionReason?.type,'safetyCheck');
    }
    await assert.rejects(stat(join(root,'guarded.txt')),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed real CLI refuses Bash obfuscated flag mutation even with acceptEdits and whole Bash allow',{
  timeout:35000,
},async()=>{
  const result=await testActualCli({
    command:"touch obfuscated-should-not-exist.txt $'-a'",
    flags:['--allow-edits','--allowedTools','Bash'],
    shouldFail:true,mustNotCreate:'obfuscated-should-not-exist.txt',
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});


test('original jq command preflight guards and new 2.1.304 parsed-argv file/module checks',{
  timeout:30000,
},async()=>{
  // Original 2.1.88 bashSecurity.ts:validateJqCommand checks system()
  // and file-reading flags. CLI 2.1.304 chunk-jfhbcs0s.js additionally
  // checks parsed include/import and joined -f/-L forms.
  // Each must precede exact Bash permission and acceptEdits approvals.
  const root=await mkdtemp(join(tmpdir(),'agent-original-jq-'));
  try{
    await writeFile(join(root,'input.json'),'{}');
    const context=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    for(const [command,reason] of [
      ['jq -f script.jq input.json',/dangerous flags/],
      ['jq --rawfile cfg secret.txt . input.json',/dangerous flags/],
      ['jq -L modules . input.json',/dangerous flags/],
      ['jq -rf script.jq input.json',/dangerous flags/],
      ["jq 'include \"sample\"; .' input.json",/include\/import/],
      ["jq 'import \"sample\" as sample; .' input.json",/include\/import/],
      ["jq 'system(\"whoami\")' input.json",/system\(\)/],
      ['env SAFE=1 jq --slurpfile cfg secret.json . input.json',/dangerous flags/],
    ]){
      const result=await bashToolCheckAstPermission(
        {command},context,{workspace:root});
      assert.equal(result.behavior,'ask',JSON.stringify({command,result}));
      assert.equal(result.decisionReason?.type,'safetyCheck',command);
      assert.match(result.message,reason,command);
    }
    // Preserve the ordinary jq filter path rather than globally banning jq:
    // the source guards operate only on the unsafe argument forms.
    const {checkOriginalJqCommandSecurity}=await import(
      '../../runtime/src/legacy-permissions/original-bash-jq-validation.js');
    assert.equal(checkOriginalJqCommandSecurity('jq . input.json',
      ['jq','.','input.json']).behavior,'passthrough');
  }finally{await rm(root,{recursive:true,force:true})}
});

test('real packed CLI rejects original jq file flags and 2.1.304 module loading despite Bash allow',{
  timeout:85000,
},async()=>{
  // Each real CLI run uses an authenticated streamed tool_use, the actual
  // Query permission chain, and an error tool_result returned to the model.
  // jq need not be installed; explicit approval failure is asserted rather
  // than accepting an OS "command not found" as proof of the guard.
  for(const command of [
    'jq --rawfile cfg private.json . input.json',
    "jq 'include \"plugin\"; .' input.json",
  ]){
    const result=await testActualCli({
      command,flags:['--allowedTools','Bash'],shouldFail:true,
    });
    assert.match(String(result.output),/approval|permission|denied/i,command);
  }
});


test('2.1.304 find/awk preflight preserves original AST argv and refuses shell effects',{
  timeout:30000,
},async()=>{
  const {checkNewerBashFindAwkSemantics}=await import(
    '../../runtime/src/legacy-permissions/original-bash-find-awk-semantics.js');
  const root=await mkdtemp(join(tmpdir(),'agent-bash-newer-find-awk-'));
  try{
    await writeFile(join(root,'safe.txt'),'KEEP_ORIGINAL_BYTES');
    const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],deny:[],ask:[],
    }});
    for(const [command,reason] of [
      ['find . -delete',/find with '-delete'/],
      ['find . -exec touch touched.txt \;',/exec|approval|cannot be safely parsed/i],
      ['find . -fprint touched.txt',/find with '-fprint'/],
      ['find . -sf',/read differently/],
      ['awk \'BEGIN { system("touch touched.txt") }\'',/awk program contains system/],
      ['gawk \'BEGIN { @include "source.awk" }\'',/@load\/@include/],
      ['awk \'BEGIN { print "echo touch touched.txt" | "sh" }\'',/command pipe/],
      ['mawk -f unsafe.awk safe.txt',/option/],
    ]){
      const decision=await bashToolCheckAstPermission({command},ctx,{workspace:root});
      assert.notEqual(decision.behavior,'allow',
        'never grant source/newer unsafe argv: '+command);
      assert.match(decision.message,reason,JSON.stringify({command,decision}));
    }
    for(const [argv,expected] of [
      [['find','.','-delete'],'ask'],
      [['find','.','-name','*.txt'],'passthrough'],
      [['awk','{print $1}','safe.txt'],'passthrough'],
      [['gawk','BEGIN {system("echo bad")}'],'ask'],
      [['awk','@include "remote.awk"'],'ask'],
      [['xargs','find'],'ask'],
      [['xargs','jq','-n','1'],'ask'],
      [['xargs','awk'],'ask'],
      [['xargs','awk','BEGIN { print 1 }'],'passthrough'],
      [['xargs','awk','-F',':','{print $1}'],'passthrough'],
      [['xargs','-0','find'],'ask'],
      [['command','find','.','-delete'],'ask'],
      [['command','-p','find','.','-delete'],'ask'],
      [['command','--','find','.','-delete'],'ask'],
      [['builtin','find','.','-delete'],'ask'],
      [['noglob','find','.','-delete'],'ask'],
      [['command','xargs','find'],'ask'],
      [['command','-v','find'],'passthrough'],
      [['jq','-n','include "unsafe"'],'ask'],
      [['command','jq','-n','include "unsafe"'],'ask'],
      [['command','jq','-n','system("echo bad")'],'ask'],
      [['command','jq','-nLf','unsafe.jq'],'ask'],
      [['command','jq','-n','1'],'passthrough'],
      [['set','-o','globsubst'],'ask'],
      [['set','-o','extendedglob'],'ask'],
      [['set','-o','pipefail'],'passthrough'],
      [['print','-P','$(touch touched.txt)'],'ask'],
      [['jobs','-x','touch','touched.txt'],'ask'],
      [['test','-t','terminal_name'],'ask'],
      [['test','-t','1'],'passthrough'],
      [['test','value','-eq','1'],'ask'],
      [['test','1','-eq','2'],'passthrough'],
      [['[','value','-eq','1'],'ask'],
      [['[[','value','-eq','1'],'ask'],
      [['[[','1','-eq','2'],'passthrough'],
      [['printf','%d','arr[$(id)]'],'ask'],
      [['watch','touch','touched.txt'],'ask'],
      [['setopt','globsubst'],'ask'],
      [['unsetopt','noglob'],'ask'],
      [['shopt','-s','expand_aliases'],'ask'],
      [['autoload','unsafe_function'],'ask'],
      [['functions','unsafe_function'],'ask'],
      [['repeat','2','touch','touched.txt'],'ask'],
      [['foreach','x','(a)','touch','touched.txt'],'ask'],
      [['zcompile','unsafe_function'],'ask'],
      [['disable','-r','command'],'ask'],
      [['typeset','-T','PATH','path'],'ask'],
      [['typeset','-n','X=Y'],'ask'],
      [['export','-u','PATH'],'ask'],
      [['export','-m','PATH'],'ask'],
      [['readonly','-m','PATH'],'ask'],
      [['private','-m','PATH'],'ask'],
      [['float','x'],'ask'],
      [['integer','x=1'],'ask'],
      [['typeset','SAFE=literal'],'passthrough'],
    ]){
      assert.equal(checkNewerBashFindAwkSemantics(argv).behavior,expected,
        JSON.stringify(argv));
    }
    assert.equal(await readFile(join(root,'safe.txt'),'utf8'),'KEEP_ORIGINAL_BYTES');
    await assert.rejects(stat(join(root,'touched.txt')),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed real CLI denies find deletion and awk execution under Bash whole-tool allow',{
  timeout:85000,
},async()=>{
  const find=await testActualCli({
    command:'find . -delete',
    flags:['--allowedTools','Bash'],
    files:[['safe.txt','KEEP_ORIGINAL_BYTES']],
    expectedWrites:[['safe.txt','KEEP_ORIGINAL_BYTES']],
    shouldFail:true,
  });
  assert.match(String(find.output),/approval|permission|denied/i);
  const awk=await testActualCli({
    command:'awk \'BEGIN { system("touch touched.txt") }\'',
    flags:['--allowedTools','Bash'],
    shouldFail:true,mustNotCreate:'touched.txt',
  });
  assert.match(String(awk.output),/approval|permission|denied/i);
});


test('packed real CLI refuses wrapped jq code execution and module loading under whole-tool Bash allow',{
  timeout:85000,
},async()=>{
  const system=await testActualCli({
    command:'command jq -n \'system("touch touched.txt")\'',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'touched.txt',
  });
  assert.match(String(system.output),/approval|permission|denied/i);
  const module=await testActualCli({
    command:'command jq -L . -n \'include "evil"; evil\'',
    flags:['--allowedTools','Bash'],
    files:[['evil.jq','def evil: system("touch module-touched.txt");']],
    shouldFail:true,
    mustNotCreate:'module-touched.txt',
  });
  assert.match(String(module.output),/approval|permission|denied/i);
});


test('packed real CLI blocks shell-state mutation before a later side effect under whole-tool Bash allow',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    command:'set -o extendedglob; node -e "require(\'fs\').writeFileSync(\'set-touched.txt\',\'SIDE_EFFECT\')"',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'set-touched.txt',
  });
  assert.match(String(result.output),/approval|permission|denied/i);
  const zshOption=await testActualCli({
    command:'setopt globsubst; node -e "require(\'fs\').writeFileSync(\'setopt-touched.txt\',\'SIDE_EFFECT\')"',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'setopt-touched.txt',
  });
  assert.match(String(zshOption.output),/approval|permission|denied/i);
  const tiedPair=await testActualCli({
    command:'typeset -T PATH path; node -e "require(\'fs\').writeFileSync(\'typeset-touched.txt\',\'SIDE_EFFECT\')"',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'typeset-touched.txt',
  });
  assert.match(String(tiedPair.output),/approval|permission|denied/i);
});


test('2.1.304 original quote-aware glob scanner uses AST source bytes rather than invented argv metadata',{
  timeout:30000,
},async()=>{
  const {T,checkNewerBashFindAwkSemantics}=await import(
    '../../runtime/src/legacy-permissions/original-bash-find-awk-semantics.js');
  for(const [command,expected] of [
    ['find . -name *.txt',true],
    ["find . -name '*.txt'",false],
    ['find . -name "*.txt"',false],
    ['find . -name \\*.txt',false],
    ['awk *.awk',true],
    ["awk 'BEGIN {print \"*.awk\"}'",false],
    ["awk 'BEGIN {print $1}' # *.txt",false],
    ["find . -name '*.txt' && find . -name *.js",true],
  ]){
    assert.equal(T(command),expected,command);
  }
  const examples=[
    {command:'find . -name *.txt',base:'find',expected:'ask'},
    {command:"find . -name '*.txt'",base:'find',expected:'passthrough'},
    {command:'awk *.awk',base:'awk',expected:'ask'},
    {command:"awk 'BEGIN { print \"*.awk\" }'",base:'awk',expected:'passthrough'},
    // The legacy walker rebuilds .text from argv when it resolves $PATTERN.
    // That normalized text quotes the source '*' and cannot be the source of
    // truth for the newer 2.1.304 unquoted-glob predicate.
    {command:'PATTERN=literal && find . -name * "$PATTERN"',base:'find',expected:'ask'},
    {command:'PATTERN=literal && awk * "$PATTERN"',base:'awk',expected:'ask'},
  ];
  for(const {command,base,expected} of examples){
    const ast=await parseOriginalBashForSecurity(command);
    assert.equal(ast.kind,'simple',JSON.stringify({command,ast}));
    if(command.includes('$PATTERN')){
      assert.equal(T(ast.commands[0].text),false,
        'normalized legacy command.text must demonstrate the provenance-loss case');
      assert.equal(ast.commands[0].hasUnquotedGlob,true,
        'the newer glob predicate must be retained from the original AST source');
    }
    const argv=stripWrappersFromArgv(ast.commands[0].argv);
    assert.equal(argv[0],base,command);
    const checked=checkNewerBashFindAwkSemantics(argv,ast.commands[0]);
    assert.equal(checked.behavior,expected,JSON.stringify({command,checked}));
  }
  assert.match(checkNewerBashFindAwkSemantics(['find','*']).message,
    /glob characters/,'newer argv fallback also guards operands');
});

test('2.1.304 argvUnquotedGlob provenance follows each original AST argument through wrappers',{
  timeout:30000,
},async()=>{
  const {getNewerBashExtraGlobPaths}=await import(
    '../../runtime/src/legacy-permissions/original-bash-command-paths.js');
  const examples=[
    {
      command:'git diff HEAD -- /etc/*.conf',
      expected:[false,false,false,false,true],
      // 2.1.304 git path extraction owns this operand directly; it is not
      // an additional E0o glob path.
      extra:[],
    },
    {
      command:"git diff HEAD -- '/etc/*.conf'",
      expected:[false,false,false,false,false],
      extra:[],
    },
    {
      command:'git diff HEAD -- \\*.conf',
      expected:[false,false,false,false,false],
      extra:[],
    },
    {
      // The timeout wrapper and its duration are stripped for
      // command-specific validation. Provenance remains aligned to argv.
      command:'timeout 5 git diff HEAD -- /etc/*.conf',
      expected:[false,false,false,false,false,false,true],
      extra:[],
    },
    {
      command:'find . -name *.txt',
      expected:[false,false,false,true],
      extra:['*.txt'],
    },
    {
      command:"find . -name '*.txt'",
      expected:[false,false,false,false],
      extra:[],
    },
  ];
  for(const {command,expected,extra} of examples){
    const ast=await parseOriginalBashForSecurity(command);
    assert.equal(ast.kind,'simple',JSON.stringify({command,ast}));
    const sourceCommand=ast.commands[0];
    assert.deepEqual(sourceCommand.argvUnquotedGlob,expected,command);
    const normalized=stripWrappersFromArgv(sourceCommand.argv);
    const actual=getNewerBashExtraGlobPaths(
      normalized[0],normalized.slice(1),sourceCommand);
    assert.deepEqual(actual,extra,command);
  }
});

test('2.1.304 Git glob carve-out and quote-scan fallback preserve source path semantics',{
  timeout:30000,
},async()=>{
  const {
    getNewerBashExtraGlobPaths,getOriginalBashPathExtractor,
  }=await import('../../runtime/src/legacy-permissions/original-bash-command-paths.js');
  assert.deepEqual(
    getOriginalBashPathExtractor('git')(['diff','HEAD','--','*.txt']),
    ['HEAD','*.txt'],
    'the 2.1.304 Git extractor validates diff operands directly',
  );
  const examples=[
    {command:'git status *.txt',tool:'git',extra:[]},
    {command:"git status '*.txt'",tool:'git',extra:[]},
    {command:'git grep *.txt',tool:'git',extra:['*.txt']},
    {command:'git diff HEAD -- *.txt',tool:'git',extra:[]},
    {command:'git --git-dir /tmp/repo/.git status *.txt',tool:'git',extra:['*.txt']},
    {command:'git -c alias.co=checkout status *.txt',tool:'git',extra:['*.txt']},
    {command:'GIT_DIR=/tmp/repo/.git git status *.txt',tool:'git',extra:['*.txt']},
    {command:'env GIT_DIR=/tmp/repo/.git git status *.txt',tool:'git',extra:['*.txt']},
    {
      command:'grep -e "$(printf x)*.txt" file.txt',
      tool:'grep',
      extra:['__CMDSUB_OUTPUT__*.txt'],
    },
  ];
  for(const example of examples){
    const ast=await parseOriginalBashForSecurity(example.command);
    assert.equal(ast.kind,'simple',JSON.stringify({command:example.command,ast}));
    const sourceCommand=ast.commands.find(
      item=>stripWrappersFromArgv(item.argv)[0]===example.tool);
    assert.ok(sourceCommand,JSON.stringify({command:example.command,commands:ast.commands}));
    const normalized=stripWrappersFromArgv(sourceCommand.argv);
    const actual=getNewerBashExtraGlobPaths(
      normalized[0],normalized.slice(1),sourceCommand);
    assert.deepEqual(actual,example.extra,example.command);
  }
});

test('CLI 2.1.304 Bash path extractor registry and argv semantics are source-aligned',{
  timeout:30000,
},async()=>{
  const {
    getOriginalBashPathExtractor,getOriginalBashPathOperationType,
    isOriginalBashPathCommand,
  }=await import('../../runtime/src/legacy-permissions/original-bash-command-paths.js');
  const commands=[
    'cd','ls','find','mkdir','touch','rm','rmdir','mv','cp','cat','head',
    'tail','sort','uniq','wc','cut','paste','column','file','stat','diff',
    'awk','gawk','mawk','nawk','strings','hexdump','od','base64','nl',
    'sha256sum','sha1sum','md5sum','tee','tr','grep','egrep','fgrep','tac',
    'rev','fold','expand','unexpand','fmt','comm','cmp','pr','numfmt',
    'tsort','man','rg','sed','jq','git',
  ];
  assert.equal(commands.length,54);
  for(const command of commands) {
    assert.equal(isOriginalBashPathCommand(command),true,command);
    assert.equal(typeof getOriginalBashPathExtractor(command),'function',command);
    assert.ok(['read','write','create'].includes(
      getOriginalBashPathOperationType(command)),command);
  }
  const cases=[
    ['cd',['-P','src'],['src']],
    ['ls',['-l','src','-a'],['src','-a']],
    ['cat',['input.txt','--literal'],['input.txt','--literal']],
    ['cut',['-d',':','-f','1','input.txt'],['input.txt']],
    ['column',['-t','-s',':','input.txt'],['input.txt']],
    ['awk',['-F',':','{print $1}','input.txt'],['input.txt']],
    ['gawk',['-f','script.awk','input.txt'],['script.awk','input.txt']],
    ['mawk',['-e','print 1','input.txt'],['input.txt']],
    ['nawk',['-v','x=1','-f','script.awk','input.txt'],['script.awk','input.txt']],
    ['egrep',['-e','secret','input.txt'],['input.txt']],
    ['fgrep',['-f','patterns.txt','input.txt'],['patterns.txt','input.txt']],
    ['tac',['-b','-s','x','input.txt'],['input.txt']],
    ['rev',['input.txt'],['input.txt']],
    ['fold',['-w','80','input.txt'],['input.txt']],
    ['expand',['-t','4','input.txt'],['input.txt']],
    ['unexpand',['-a','-t','4','input.txt'],['input.txt']],
    ['fmt',['-w','80','input.txt'],['input.txt']],
    ['comm',['-1','-2','a.txt','b.txt'],['a.txt','b.txt']],
    ['cmp',['-s','a.txt','b.txt'],['a.txt','b.txt']],
    ['pr',['-h','header','input.txt'],['input.txt']],
    ['numfmt',['--to=si','--suffix=B','input.txt'],['input.txt']],
    ['tsort',['input.txt'],['input.txt']],
    ['man',['-l','./manual.1'],['./manual.1']],
    ['rg',['-g','*.js','needle','src'],['src']],
    ['jq',['--from-file=filter.jq','input.json'],['filter.jq','input.json']],
    ['git',['grep','needle','src/file.js'],['src/file.js']],
    ['git',['diff','HEAD','--','src/file.js'],['HEAD','src/file.js']],
    ['tee',['-a','output.txt'],['output.txt']],
    ['tee',['/dev/null','output.txt'],['output.txt']],
  ];
  for(const [command,args,expected] of cases) {
    assert.deepEqual(getOriginalBashPathExtractor(command)(args),expected,
      command+' '+JSON.stringify(args));
  }
  assert.equal(getOriginalBashPathOperationType('tee'),'write');
  assert.equal(getOriginalBashPathOperationType('gawk'),'read');
  assert.equal(getOriginalBashPathOperationType('egrep'),'read');
});

test('2.1.304 cd rejects zsh OLD NEW form even under whole-tool Bash allow',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-cd-multi-'));
  try {
    const context=createCliPermissionContext({
      permissionRules:{allow:[{toolName:'Bash'}],deny:[],ask:[]},
    });
    for(const command of ['cd old new','cd -P old new','cd -- old new']) {
      const decision=await bashToolCheckAstPermission(
        {command},context,{workspace:root});
      assert.equal(decision.behavior,'ask',command+': '+JSON.stringify(decision));
      assert.match(decision.message,/cd with two or more directory arguments/i);
    }
    const {
      getOriginalBashPathExtractor,validateOriginalBashPathCommand,
    }=await import('../../runtime/src/legacy-permissions/original-bash-command-paths.js');
    assert.deepEqual(getOriginalBashPathExtractor('cd')(['-P','old']),['old']);
    const single=validateOriginalBashPathCommand(
      'cd',['-P','old'],root,context);
    assert.notEqual(single.behavior,'ask',
      'one directory operand after a valid option must not be mistaken for zsh cd substitution');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('2.1.304 Bash path aliases cannot bypass scoped path validation under whole-tool allow',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-new-bash-paths-'));
  try {
    const context=createCliPermissionContext({
      permissionRules:{allow:[{toolName:'Bash'}],deny:[],ask:[]},
    });
    for(const command of [
      'egrep -e secret ../outside.txt',
      'gawk -f ../outside.awk input.txt',
      'man -l ../outside.man',
    ]) {
      const decision=await bashToolCheckAstPermission(
        {command},context,{workspace:root});
      assert.equal(decision.behavior,'ask',command+': '+JSON.stringify(decision));
    }
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('2.1.304 tee path extraction protects file targets and permits stream-only targets',{
  timeout:30000,
},async()=>{
  const {
    getOriginalBashPathExtractor,getOriginalBashPathOperationType,
  }=await import('../../runtime/src/legacy-permissions/original-bash-command-paths.js');
  const extract=getOriginalBashPathExtractor('tee');
  assert.equal(getOriginalBashPathOperationType('tee'),'write');
  assert.deepEqual(extract(['-a','output.txt']),['output.txt']);
  assert.deepEqual(extract(['--','-literal.txt']),['-literal.txt']);
  assert.deepEqual(extract(['/dev/null','/dev/stdout','/dev/stderr','/dev/tty']),[]);
  assert.deepEqual(extract(['/dev/null','outside.txt']),['outside.txt']);

  const workspace=await mkdtemp(join(tmpdir(),'agent-cil-tee-path-'));
  try{
    const context=createCliPermissionContext({
      permissionRules:{allow:[{toolName:'Bash'}],deny:[],ask:[]},
    });
    const outside=await bashToolCheckAstPermission(
      {command:'tee ../outside.txt'},context,{workspace});
    assert.equal(outside.behavior,'ask',
      'tee must not let a whole-tool Bash allow authorize a path outside the workspace');
    const streamOnly=await bashToolCheckAstPermission(
      {command:'tee /dev/null'},context,{workspace});
    assert.equal(streamOnly.behavior,'passthrough',
      'the AST path gate must not prompt for standard stream targets; the outer whole-tool rule decides');
  }finally{
    await rm(workspace,{recursive:true,force:true});
  }
});

test('2.1.304 Bash write paths reject runtime substitutions and validate cp/mv source reads',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-dynamic-path-'));
  try{
    const allowBash=createCliPermissionContext({allowEdits:true,
      permissionRules:{allow:[{toolName:'Bash'}],deny:[],ask:[]},
    });
    const {validateOriginalBashPathCommand}=await import(
      '../../runtime/src/legacy-permissions/original-bash-command-paths.js');
    const pathGate=validateOriginalBashPathCommand(
      'touch',['__CMDSUB_OUTPUT__agent-cil-dynamic-path-bypass.txt'],
      root,allowBash);
    assert.equal(pathGate.behavior,'ask',JSON.stringify(pathGate));
    assert.equal(pathGate.decisionReason?.bashMissKind,'shell-expansion',
      JSON.stringify(pathGate));

    // Embedded command-substitution output remains represented by the old
    // AST placeholder. The packed CLI must not treat that literal placeholder
    // as proof that the eventual filesystem target is inside the workspace.
    const dynamic=await bashToolCheckAstPermission({
      command:'touch "$(printf ../)agent-cil-dynamic-path-bypass.txt"',
    },allowBash,{workspace:root});
    assert.notEqual(dynamic.behavior,'allow',JSON.stringify(dynamic));

    await writeFile(join(root,'cp-secret.txt'),'CP_READ_DENIED');
    await writeFile(join(root,'mv-secret.txt'),'MV_READ_DENIED');
    const readDenied=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[
        {toolName:'Read',ruleContent:'cp-secret.txt'},
        {toolName:'Read',ruleContent:'mv-secret.txt'},
      ],
      ask:[],
    }});
    for(const command of [
      'cp cp-secret.txt cp-copy.txt',
      'mv mv-secret.txt mv-moved.txt',
    ]){
      const decision=await bashToolCheckAstPermission(
        {command},readDenied,{workspace:root});
      assert.equal(decision.behavior,'deny',command+': '+JSON.stringify(decision));
      assert.equal(decision.decisionReason?.type,'rule',command);
    }

    // The newer source returns an explicit path DENY before a preceding
    // non-rule path ASK when a later cp source has a Read(path) deny.
    const precedence=createCliPermissionContext({permissionRules:{
      allow:[{toolName:'Bash'}],
      deny:[{toolName:'Read',ruleContent:'cp-secret.txt'}],
      ask:[{toolName:'Edit',ruleContent:'review-source.txt'}],
    }});
    const deniedAfterAsk=await bashToolCheckAstPermission({
      command:'cp review-source.txt cp-secret.txt cp-copy.txt',
    },precedence,{workspace:root});
    assert.equal(deniedAfterAsk.behavior,'deny',JSON.stringify(deniedAfterAsk));
    assert.equal(deniedAfterAsk.decisionReason?.rule?.ruleValue?.ruleContent,
      'cp-secret.txt',JSON.stringify(deniedAfterAsk));
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test('packed CLI blocks dynamic Bash write paths and cp/mv source Read denials',{
  timeout:85000,
},async()=>{
  const marker='agent-cil-dynamic-path-'+process.pid+'.txt';
  const dynamic=await testActualCli({
    command:'touch "$(printf ../)'+marker+'"',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'../'+marker,
  });
  assert.match(String(dynamic.output),/approval|permission|denied/i);

  const cp=await testActualCli({
    command:'cp cp-secret.txt cp-copy.txt',
    flags:['--allowedTools','Bash','--disallowedTools','Read(cp-secret.txt)'],
    files:[['cp-secret.txt','CP_READ_DENIED']],
    shouldFail:true,
    mustNotCreate:'cp-copy.txt',
  });
  assert.match(String(cp.output),/approval|permission|denied/i);

  const mv=await testActualCli({
    command:'mv mv-secret.txt mv-moved.txt',
    flags:['--allowedTools','Bash','--disallowedTools','Read(mv-secret.txt)'],
    files:[['mv-secret.txt','MV_READ_DENIED']],
    shouldFail:true,
    mustNotCreate:'mv-moved.txt',
  });
  assert.match(String(mv.output),/approval|permission|denied/i);
});

test('packed real CLI requires approval for zsh cd OLD NEW form under whole-tool Bash allow',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    // Bash would run the fallback touch if the source-level cd safety
    // decision were bypassed by the whole-tool Bash allow.
    command:'cd old new || touch cd-multi-bypass.txt',
    flags:['--allowedTools','Bash'],
    mustNotCreate:'cd-multi-bypass.txt',
    shouldFail:true,
  });
  // --print has no interactive approval UI, so the real CLI returns its
  // normal fail-closed approval-unavailable tool result. The source-level
  // decision reason is asserted by the direct policy test above.
  assert.match(String(result.output),/approval|permission|denied/i);
});

test('packed real CLI validates the 2.1.304 egrep path alias under whole-tool Bash allow',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    command:'egrep -e secret ../outside.txt',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});

test('packed real CLI denies glob-expanded find actions despite whole-tool Bash allow',{
  timeout:45000,
},async()=>{
  // This fixture contains an option-looking filename that an unquoted
  // wildcard could expand to before find parses its argv. No command may
  // touch it or the protected readme.
  const command='find . -name *';
  const result=await testActualCli({
    command,
    flags:['--allowedTools','Bash'],
    files:[['-delete','OPTION_LOOKALIKE'],['protected.txt','DO_NOT_DELETE']],
    expectedWrites:[['-delete','OPTION_LOOKALIKE'],['protected.txt','DO_NOT_DELETE']],
    shouldFail:true,
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});

test('packed real CLI preserves raw unquoted-glob provenance when argv normalization quotes it',{
  timeout:85000,
},async()=>{
  const command='PATTERN=literal && find . -name * "$PATTERN"; '+
    'node -e "require(\'fs\').writeFileSync(\'guarded.txt\',\'SIDE_EFFECT\')"';
  const result=await testActualCli({
    command,
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'guarded.txt',
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});


test('packed real CLI refuses xargs-injected find and awk programs under whole-tool Bash allow',{
  timeout:85000,
},async()=>{
  const commandFind=await testActualCli({
    command:'command find . -delete',
    flags:['--allowedTools','Bash'],
    files:[['safe.txt','KEEP_ORIGINAL_BYTES']],
    expectedWrites:[['safe.txt','KEEP_ORIGINAL_BYTES']],
    shouldFail:true,
  });
  assert.match(String(commandFind.output),/approval|permission|denied/i);
  const find=await testActualCli({
    command:'xargs find < args.txt',
    flags:['--allowedTools','Bash'],
    files:[['args.txt','-delete'],['safe.txt','KEEP_ORIGINAL_BYTES']],
    expectedWrites:[['args.txt','-delete'],['safe.txt','KEEP_ORIGINAL_BYTES']],
    shouldFail:true,
  });
  assert.match(String(find.output),/approval|permission|denied/i);
  const awk=await testActualCli({
    command:'xargs awk < args.txt',
    flags:['--allowedTools','Bash'],
    files:[['args.txt','BEGIN{system(\\"touch${IFS}touched.txt\\")}']],
    shouldFail:true,
    mustNotCreate:'touched.txt',
  });
  assert.match(String(awk.output),/approval|permission|denied/i);
});


test('2.1.304 Qe redirect checks reject omitted source and swallowed post-redirect argv',{
  timeout:30000,
},async()=>{
  const {parseForSecurityFromAst}=await import(
    '../../runtime/src/legacy-permissions/generated/ast.js');
  function analyze(redirectText,parts){
    const prefix='echo ';
    const command=prefix+redirectText;
    const position=Buffer.byteLength(prefix);
    const children=parts.map(([type,value,relativeStart])=>({
      type,text:value,
      startIndex:position+relativeStart,
      endIndex:position+relativeStart+Buffer.byteLength(value),
      children:[],
    }));
    const redirect={type:'file_redirect',text:redirectText,
      startIndex:position,endIndex:Buffer.byteLength(command),children};
    const tree={type:'program',text:command,startIndex:0,
      endIndex:Buffer.byteLength(command),children:[{
        type:'redirected_statement',text:command,startIndex:0,
        endIndex:Buffer.byteLength(command),children:[redirect],
      }]};
    return parseForSecurityFromAst(command,tree);
  }
  for(const [text,children,reason] of [
    ['> safe.txt BAD',[['>','>',0],['word','safe.txt',2]],
      /unparsed trailing bytes/],
    ['> safe.txt bad',[['>','>',0],['word','safe.txt',2],['word','bad',11]],
      /multiple targets/],
    ['>& -1',[['>&','>&',0],['word','-1',3]],
      /dash as close-fd/],
    ['>&- extra',[['>&-','>&-',0],['word','extra',4]],
      /Close-fd redirect is followed/],
  ]){
    const result=analyze(text,children);
    assert.equal(result.kind,'too-complex',JSON.stringify({text,result}));
    assert.match(result.reason,reason,text);
  }
  const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
    allow:[{toolName:'Bash'}],deny:[],ask:[],
  }});
  const ordinary=await bashToolCheckAstPermission({command:'printf safe'},ctx);
  assert.equal(ordinary.behavior,'passthrough',JSON.stringify(ordinary));
  // No source-level safety fence is raised; the normal permission resolver
  // still decides whether a harmless command is authorized.
});

test('packed CLI refuses a redirect which swallows later argv under whole-tool Bash allow',{
  timeout:85000,
},async()=>{
  const result=await testActualCli({
    command:'echo UNSAFE > redirect-touched.txt another',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'redirect-touched.txt',
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});

test('2.1.304 fd-variable redirect source-node guard fences shell side effects',{
  timeout:85000,
},async()=>{
  const {parseForSecurityFromAst}=await import(
    '../../runtime/src/legacy-permissions/generated/ast.js');
  const command='echo message {fd}> output.txt';
  const nameOffset=Buffer.byteLength('echo message ');
  const node={type:'word',text:'{fd}',startIndex:nameOffset,
    endIndex:nameOffset+4,children:[]};
  const root={type:'program',text:command,startIndex:0,
    endIndex:Buffer.byteLength(command),children:[{
      type:'command',text:command,startIndex:0,
      endIndex:Buffer.byteLength(command),children:[node],
    }]};
  const result=parseForSecurityFromAst(command,root);
  assert.equal(result.kind,'too-complex',JSON.stringify(result));
  assert.match(result.reason,/fd-variable assignment/);
  const normal=await parseOriginalBashForSecurity('echo message 2> output.txt');
  assert.equal(normal.kind,'simple',JSON.stringify(normal));
  const actual=await testActualCli({
    command:'echo message {fd}> side-effect.txt; node -e "require(\'fs\').writeFileSync(\'guarded.txt\',\'MUTATED\')"',
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'guarded.txt',
  });
  assert.match(String(actual.output),/approval|permission|denied/i);
});

test('2.1.304 AST refuses parser-skipped source gaps before permission auto-allow',{
  timeout:30000,
},async()=>{
  const {parseForSecurityFromAst}=await import(
    '../../runtime/src/legacy-permissions/generated/ast.js');
  const leaf=(text,startIndex)=>({
    type:'command',text,startIndex,
    endIndex:startIndex+Buffer.byteLength(text),children:[],
  });
  for(const [command,children,reason] of [
    ['echo ok;rm target',[leaf('echo ok',0)],/trailing input/],
    ['echo ok;rm target',[leaf('echo ok',0),leaf('target',11)],/skipped input/],
    ['echo ok',[leaf('echo ok',0)],null],
    ['echo ok;',[leaf('echo ok',0)],null],
    ['echo ok\\\n;',[leaf('echo ok',0)],null],
  ]){
    const ast={type:'program',text:command,startIndex:0,
      endIndex:Buffer.byteLength(command),children};
    const result=parseForSecurityFromAst(command,ast);
    if(reason){
      assert.equal(result.kind,'too-complex',JSON.stringify({command,result}));
      assert.match(result.reason,reason);
    }else{
      // A forged valid source-spanning root may still be rejected by the
      // remaining original semantic walker. It must not be rejected for
      // a nonexistent source-coverage gap.
      assert.doesNotMatch(result.reason??'',/Parser skipped input|Parser did not consume trailing/);
    }
  }
  const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
    allow:[{toolName:'Bash'}],ask:[],deny:[],
  }});
  const normal=await bashToolCheckAstPermission({command:'echo source-coverage-ok'},ctx);
  assert.equal(normal.behavior,'allow',JSON.stringify(normal));
});

test('2.1.304 AST differential preflight rejects lone surrogate and zsh numeric range without replacing 2.1.88 parser',{
  timeout:30000,
},async()=>{
  const {checkNewerBashAstLexicalPreflight}=await import(
    '../../runtime/src/legacy-permissions/newer-bash-ast-lexical-preflight.js');
  const check=checkNewerBashAstLexicalPreflight;
  const bt=String.fromCharCode(96);
  for(const [command,reason] of [
    ['echo \uD800',/lone surrogate/],
    ['echo \uDC00',/lone surrogate/],
    ['echo A\uD800B',/lone surrogate/],
    ['echo <1-9>',/zsh <N-M>/],
    ["echo '<0-10>'",/zsh <N-M>/],
    ['echo <-5>',/zsh <N-M>/],
    ['echo <5->',/zsh <N-M>/],
    ['echo "foo"'+bt+'\n'+bt+'"bar"',/empty backtick substitution/],
    ['echo '+bt+'printf ok',/backtick_body_overrun/],
    ['echo '+bt+'printf \\q'+bt,/backtick_escape_unsupported/],
  ]){
    const result=check(command);
    assert.equal(result.kind,'too-complex',command);
    assert.equal(result.differential,true);
    assert.match(result.reason,reason,command);
  }
  for(const command of [
    'echo normal','echo A\uD83D\uDE00B',
    'echo <hello-world>','echo <1-5','echo 1-5>',
    "echo '"+bt+bt+"'",
    'echo '+String.fromCharCode(92)+bt,
  ]){
    assert.equal(check(command).kind,'passthrough',command);
  }
  const ctx=createCliPermissionContext({allowEdits:true,permissionRules:{
    allow:[{toolName:'Bash'}],ask:[],deny:[],
  }});
  // This is an existing allowed Bash command with a *quoted* range.
  // The newer original pre-parser rejects even this case rather than
  // silently bypassing the check when the AST old parser understands quotes.
  const blocked=await bashToolCheckAstPermission({
    command:"echo '<1-9>'",
  },ctx);
  assert.equal(blocked.behavior,'ask',JSON.stringify(blocked));
  assert.equal(blocked.decisionReason?.type,'safetyCheck');
  assert.match(blocked.decisionReason?.reason??'',/zsh <N-M>/);
  const emptyBacktickCommand='to'+bt+'\n'+bt+'uch touched.txt';
  const emptyBacktick=await testActualCli({
    command:emptyBacktickCommand,
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'touched.txt',
  });
  assert.match(String(emptyBacktick.output),/approval|permission|denied/i);
  const normal=await bashToolCheckAstPermission({
    command:'node --version',
  },ctx);
  assert.equal(normal.behavior,'allow',JSON.stringify(normal));
});

test('packed real CLI preserves side-effect file when newer zsh range check rejects Bash whole-tool allow',{
  timeout:45000,
},async()=>{
  const command='node -e "require(\'fs\').writeFileSync(\'guarded.txt\',\'SIDE_EFFECT\')" \'<1-3>\'';
  const result=await testActualCli({
    command,
    flags:['--allowedTools','Bash'],
    shouldFail:true,
    mustNotCreate:'guarded.txt',
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});

test('original 2.1.88 heredoc extractor preserves quoted-only expansion and unsafe fallback',{
  timeout:30000,
},async()=>{
  const {extractHeredocs,restoreHeredocs,containsHeredoc}=await import(
    '../../runtime/src/legacy-permissions/original-bash-heredoc.js');
  const {checkOriginalBashFurtherMisparsing}=await import(
    '../../runtime/src/legacy-permissions/original-bash-safety-further.js');
  const quoted="cat <<'SAFE'\n{one,two}\nSAFE";
  const q=extractHeredocs(quoted,{quotedOnly:true});
  assert.equal(q.heredocs.size,1);
  assert.equal(q.processedCommand.includes('{one,two}'),false);
  assert.equal(restoreHeredocs([q.processedCommand],q.heredocs)[0],quoted);
  assert.equal(checkOriginalBashFurtherMisparsing(quoted).behavior,'passthrough');
  const unquoted="cat <<RAW\n{one,two}\nRAW";
  assert.equal(extractHeredocs(unquoted,{quotedOnly:true}).processedCommand,unquoted);
  assert.equal(checkOriginalBashFurtherMisparsing(unquoted).behavior,'ask');
  const nested="cat <<RAW\n<<'HIDDEN'\n$(touch guarded.txt)\nHIDDEN\nRAW";
  assert.equal(extractHeredocs(nested,{quotedOnly:true}).heredocs.size,0);
  assert.equal(extractHeredocs("cat <<'Q'\n$(touch guarded.txt)",{quotedOnly:true}).heredocs.size,0);
  assert.equal(extractHeredocs("(( x=1 << 2 ))\necho safe",{quotedOnly:true}).heredocs.size,0);
  const ticks=String.fromCharCode(96);
  assert.equal(extractHeredocs("echo "+ticks+"pwd"+ticks+"; cat <<'Q'\n$(touch guarded.txt)\nQ",{quotedOnly:true}).heredocs.size,0);
  assert.equal(extractHeredocs("cat <<RAW <<'Q'\n$(touch guarded.txt)\nRAW\nbody\nQ",{quotedOnly:true}).heredocs.size,0);
  assert.equal(extractHeredocs("cat <<-'TAB'\n\t{one,two}\n\tTAB",{quotedOnly:true}).heredocs.size,1);
  assert.equal(containsHeredoc(quoted),true);
  assert.equal(containsHeredoc('echo safe'),false);
});

test('heredoc preprocessing cannot override original Bash AST or whole-tool grant',{
  timeout:30000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-original-heredoc-'));
  try{
    const context=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[{toolName:'Bash'}],ask:[],deny:[],
    }});
    const command="cat <<RAW\n$(touch guarded.txt)\nRAW";
    const result=await bashToolCheckAstPermission({command},context,{workspace:root});
    assert.notEqual(result.behavior,'allow',JSON.stringify(result));
    const quoted="cat <<'Q'\n{one,two}\nQ";
    // The quoted body is literal in Bash. Use a context without a Bash grant
    // to prove heredoc extraction itself never creates authorization; the
    // unquoted command above separately proves it cannot bypass a whole-tool
    // grant when the original AST detects expansion.
    const safeWithGrant=await bashToolCheckAstPermission({command:quoted},context,{workspace:root});
    assert.equal(safeWithGrant.behavior,'allow',
      'a quoted literal heredoc remains allowed after the original AST validates it');
    const noGrantContext=createCliPermissionContext({allowEdits:true,permissionRules:{
      allow:[],ask:[],deny:[],
    }});
    const safe=await bashToolCheckAstPermission({command:quoted},noGrantContext,{workspace:root});
    assert.notEqual(safe.behavior,'allow','Heredoc extraction alone must not grant permission');
    await assert.rejects(stat(join(root,'guarded.txt')),{code:'ENOENT'});
  }finally{await rm(root,{recursive:true,force:true})}
});

test('packed CLI blocks unquoted heredoc substitution before any disk effect',{
  timeout:45000,
},async()=>{
  const result=await testActualCli({
    command:"cat <<RAW\n$(touch guarded.txt)\nRAW",
    flags:['--allow-edits','--allowedTools','Bash'],shouldFail:true,
    mustNotCreate:'guarded.txt',
  });
  assert.match(String(result.output),/approval|permission|denied/i);
});
