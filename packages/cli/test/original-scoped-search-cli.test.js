/**
 * Original 2.1.88 GrepTool/GlobTool search-side Read(path) deny exclusions.
 * Exercised through native bounded walker AND packed real agent-cil process.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBuiltinTools,createCliPermissionPolicy,createCliPermissionContext} from '../src/index.js';
import {getFileReadIgnorePatterns} from '../../runtime/src/legacy-permissions/original-bash-read-paths.js';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const frame=(type,data={})=>
  'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
function stream(toolName,input){
  return frame('message_start',{message:{usage:{input_tokens:17}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id:'search-owned-test',name:toolName,input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'}})+frame('message_stop');
}
const done=()=>frame('message_start',{message:{usage:{input_tokens:15}}})+
  frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
  frame('content_block_delta',{index:0,delta:{
    type:'text_delta',text:'SCOPED_SEARCH_VERIFIED',
  }})+
  frame('content_block_stop',{index:0})+
  frame('message_delta',{delta:{stop_reason:'end_turn'}})+frame('message_stop');

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'agent-cil-scoped-search-'));
  const outside=await mkdtemp(join(tmpdir(),'agent-cil-scoped-search-outside-'));
  await mkdir(join(root,'private'));
  await mkdir(join(root,'nested'));
  await writeFile(join(root,'public.txt'),'SEARCH_PUBLIC_TOKEN\n');
  await writeFile(join(root,'secret.txt'),'SEARCH_SECRET_TOKEN\n');
  await writeFile(join(root,'review.txt'),'SEARCH_REVIEW_TOKEN\n');
  await writeFile(join(root,'private','inside.txt'),'SEARCH_PRIVATE_TOKEN\n');
  await writeFile(join(root,'nested','visible.txt'),'SEARCH_NESTED_TOKEN\n');
  await writeFile(join(outside,'foreign.txt'),'SEARCH_FOREIGN_TOKEN\n');
  try{
    await symlink(join(outside,'foreign.txt'),join(root,'foreign-link.txt'));
  }catch(error){
    if(!['EPERM','EACCES','ENOTSUP'].includes(error?.code))throw error;
  }
  return {root,outside};
}

const permissions=()=>createCliPermissionContext({permissionRules:{
  allow:[],deny:[
    {toolName:'Read',ruleContent:'secret.txt'},
    {toolName:'Read',ruleContent:'private/**'},
  ],ask:[{toolName:'Read',ruleContent:'review.txt'}],
}});

test('original getFileReadIgnorePatterns keeps gitignore keys from Read deny rules',()=>{
  const patterns=getFileReadIgnorePatterns(permissions());
  assert.deepEqual([...patterns.get(null)].sort(),['private/**','secret.txt']);
});

test('source Grep/Glob native search filters denied and ask paths before disclosure',{
  timeout:25000,
},async()=>{
  const {root,outside}=await fixture();
  try{
    const ctx=permissions();
    const policy=createCliPermissionPolicy({workspace:root,permissionContext:ctx});
    const toolset=await createBuiltinTools({workspace:root,permissionContext:ctx});
    assert.equal((await policy({name:'Glob',input:{pattern:'**/*.txt'}})).behavior,'allow');
    assert.equal((await policy({name:'Grep',input:{pattern:'SEARCH_',path:'.'}})).behavior,'allow');
    assert.equal((await policy({name:'Grep',input:{pattern:'SECRET',path:'secret.txt'}})).behavior,'deny');
    assert.equal((await policy({name:'Grep',input:{pattern:'REVIEW',path:'review.txt'}})).behavior,'ask');
    assert.equal((await policy({name:'Grep',input:{pattern:'PRIVATE',path:'private'}})).behavior,'deny');
    const glob=await toolset.get('Glob').execute({pattern:'**/*.txt'});
    assert.deepEqual(glob.matches.sort(),['nested/visible.txt','public.txt']);
    const grep=await toolset.get('Grep').execute({pattern:'SEARCH_',path:'.'});
    assert.equal(grep.matches.length,2,JSON.stringify(grep));
    assert.deepEqual(grep.matches.map(x=>x.path).sort(),['nested/visible.txt','public.txt']);
    assert.ok(grep.matches.every(x=>/SEARCH_(PUBLIC|NESTED)_TOKEN/.test(x.text)));
    const single=await toolset.get('Grep').execute({pattern:'SEARCH_',path:'secret.txt'});
    assert.deepEqual(single.matches,[],'direct native execute cannot bypass Read(path) deny');
    const askSingle=await toolset.get('Grep').execute({pattern:'SEARCH_',path:'review.txt'});
    assert.deepEqual(askSingle.matches,[],'direct native execute cannot bypass Read(path) ask');
    const outsideSearch=await policy({name:'Grep',input:{path:join(outside,'foreign.txt'),pattern:'SEARCH_'}});
    assert.equal(outsideSearch.behavior,'deny');
    const rootDenied=createCliPermissionContext({permissionRules:{
      deny:[{toolName:'Read',ruleContent:'**'}],allow:[],ask:[],
    }});
    const rootPolicy=createCliPermissionPolicy({workspace:root,permissionContext:rootDenied});
    const globRoot=await rootPolicy({name:'Glob',input:{pattern:'**/*'}});
    // Original gitignore matcher checks the root itself; matching an
    // empty relative path may passthrough. In that case the source file
    // walker must still hide ALL matched descendants.
    if(globRoot.behavior==='allow'){
      const allDenied=await createBuiltinTools({workspace:root,permissionContext:rootDenied});
      assert.deepEqual((await allDenied.get('Glob').execute({pattern:'**/*.txt'})).matches,[]);
    }else assert.equal(globRoot.behavior,'deny');
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    await rm(outside,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

async function runPackedSearch(toolName,input,flags,root){
  const received=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(received.length===1?stream(toolName,input):done());
  });
  let child,watchdog;
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-turns','3','--max-retries','0',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      ...flags,'Check original scoped search results.'],{
        env:{...process.env,DEEPSEEK_API_KEY:'local-scope-test'},
        stdio:['ignore','pipe','pipe'],
      });
    const stdout=[],stderr=[];
    child.stdout.on('data',x=>stdout.push(x));
    child.stderr.on('data',x=>stderr.push(x));
    watchdog=setTimeout(()=>child.kill('SIGKILL'),22000);
    const [code,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(c,s)=>resolve([c,s]));
    });
    assert.equal(signal,null,Buffer.concat(stderr).toString('utf8'));
    assert.equal(code,0,Buffer.concat(stderr).toString('utf8'));
    assert.match(Buffer.concat(stdout).toString('utf8'),/SCOPED_SEARCH_VERIFIED/);
    assert.equal(received.length,2);
    const result=received[1].messages.at(-1).content.find(x=>
      x.type==='tool_result'&&x.tool_use_id==='search-owned-test');
    assert.ok(result,'tool response must preserve model tool_use_id');
    assert.notEqual(result.is_error,true,JSON.stringify(result));
    const serialized=typeof result.content==='string'?result.content:JSON.stringify(result.content);
    return serialized;
  }finally{
    if(watchdog)clearTimeout(watchdog);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server.closeAllConnections?.();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
  }
}

test('installed CLI Grep and Glob do not disclose Read-denied/ask files',{
  timeout:45000,
},async()=>{
  const {root,outside}=await fixture();
  try{
    const flags=['--disallowedTools','Read(secret.txt)',
      '--disallowedTools','Read(private/**)',
      '--askTools','Read(review.txt)'];
    const glob=await runPackedSearch('Glob',{pattern:'**/*.txt'},flags,root);
    assert.match(glob,/public\.txt/);
    assert.match(glob,/visible\.txt/);
    assert.doesNotMatch(glob,/secret\.txt|review\.txt|private\/inside\.txt|foreign-link\.txt/);
    const grep=await runPackedSearch('Grep',{pattern:'SEARCH_',path:'.'},flags,root);
    assert.match(grep,/SEARCH_PUBLIC_TOKEN/);
    assert.match(grep,/SEARCH_NESTED_TOKEN/);
    assert.doesNotMatch(grep,/SEARCH_(SECRET|REVIEW|PRIVATE|FOREIGN)_TOKEN|secret\.txt|review\.txt|foreign-link/);
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
    await rm(outside,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
