import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const LF=String.fromCharCode(10);
const frame=(type,data={})=>'event: '+type+LF+
  'data: '+JSON.stringify({type,...data})+LF+LF;
function toolStream({id,name,input}){
  return frame('message_start',{message:{usage:{input_tokens:23}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'tool_use',id,name,input:{},
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'input_json_delta',partial_json:JSON.stringify(input),
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'tool_use'}})+
    frame('message_stop');
}
function finishStream(){
  return frame('message_start',{message:{usage:{input_tokens:40}}})+
    frame('content_block_start',{index:0,content_block:{
      type:'text',text:'',
    }})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'JOINT_P0_P1_CLI_ACCEPTANCE_OK',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'}})+
    frame('message_stop');
}

test('joint original P0/P1: recover unread Write; Read then Write; Bash side-effect with completed exit-7 witness; model continues exactly once',{
  timeout:45000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-joint-accept-'));
  const original='original';
  const failingShell='node -e "require(\'node:fs\').appendFileSync(\'shell-count.txt\',\'x\');process.exit(7)"';
  const sequence=[
    {id:'joint-unread-write',name:'Write',input:{
      file_path:'existing.txt',content:'overwritten',
    }},
    {id:'joint-full-read',name:'Read',input:{file_path:'existing.txt'}},
    {id:'joint-valid-write',name:'Write',input:{
      file_path:'existing.txt',content:'overwritten',
    }},
    {id:'joint-bash-exit-7',name:'Bash',input:{command:failingShell}},
    {id:'joint-bash-success',name:'Bash',input:{command:'node --version'}},
  ];
  const requests=[];
  let server,child,timer;
  try{
    await writeFile(join(root,'existing.txt'),original);
    server=createServer(async(req,res)=>{
      const body=[];
      for await(const chunk of req)body.push(chunk);
      requests.push(JSON.parse(Buffer.concat(body).toString('utf8')));
      res.writeHead(200,{'content-type':'text/event-stream'});
      const next=sequence[requests.length-1];
      res.end(next?toolStream(next):finishStream());
    });
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--cwd',root,'--max-retries','0','--max-turns','8',
      '--compact-threshold','0',
      '--allowedTools','Write','--allowedTools','Bash',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Complete source-verified recovery workflow'],{
      env:{...process.env,DEEPSEEK_API_KEY:'joint-acceptance-local'},
      stdio:['ignore','pipe','pipe'],
    });
    const out=[],err=[];
    child.stdout.on('data',x=>out.push(x));
    child.stderr.on('data',x=>err.push(x));
    timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    const [status,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,s)=>resolve([code,s]));
    });
    const stdout=Buffer.concat(out).toString('utf8');
    const stderr=Buffer.concat(err).toString('utf8');
    assert.equal(signal,null,stderr);
    assert.equal(status,0,stdout+stderr);
    assert.match(stdout,/JOINT_P0_P1_CLI_ACCEPTANCE_OK/);
    assert.equal(requests.length,sequence.length+1,
      'no fresh provider request may retry the same completed tool');
    for(let i=0;i<sequence.length;i++){
      // Source provider checkpoint sends the just-completed authenticated
      // tool_result, never a synthetic new tool_use or replay.
      const content=requests[i+1].messages.at(-1).content;
      const result=content.find(x=>x.type==='tool_result'&&
        x.tool_use_id===sequence[i].id);
      assert.ok(result,'missing mapped witness: '+sequence[i].id);
      if(i===0){
        assert.equal(result.is_error,true,'unread existing Write is recoverable');
        assert.match(result.content,/File has not been read yet/);
      }else if(i===3){
        assert.equal(result.is_error,true,
          'complete side-effecting Bash exit 7 must be a persisted model error, not fatal');
        assert.match(result.content,/Command failed with exit code 7/);
      }else{
        assert.notEqual(result.is_error,true,
          'after a completed failure the same CLI session must continue');
      }
    }
    assert.equal(await readFile(join(root,'existing.txt'),'utf8'),'overwritten');
    assert.equal(await readFile(join(root,'shell-count.txt'),'utf8'),'x',
      'side-effecting Bash failed once and was never silently retried');
  }finally{
    if(timer)clearTimeout(timer);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server?.closeAllConnections?.();
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
