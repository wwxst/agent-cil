import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cli=process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js',import.meta.url));
const LF=String.fromCharCode(10);
const frame=(type,data={})=>'event: '+type+LF+'data: '+
  JSON.stringify({type,...data})+LF+LF;
function toolStream({id,name,input}){
  return frame('message_start',{message:{usage:{input_tokens:40}}})+
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
function answer(){
  return frame('message_start',{message:{usage:{input_tokens:50}}})+
    frame('content_block_start',{index:0,content_block:{type:'text',text:''}})+
    frame('content_block_delta',{index:0,delta:{
      type:'text_delta',text:'ORIGINAL_FILE_READ_STATE_VERIFIED',
    }})+
    frame('content_block_stop',{index:0})+
    frame('message_delta',{delta:{stop_reason:'end_turn'}})+
    frame('message_stop');
}
const R=(id,input={file_path:'existing.txt'})=>({id,name:'Read',input});
const E=(id,input={file_path:'existing.txt',old_string:'alpha',new_string:'beta'})=>({id,name:'Edit',input});
const W=(id,input={file_path:'existing.txt',content:'beta'})=>({id,name:'Write',input});

async function exercise({steps,expected,mutate,initial='alpha',target='existing.txt'}) {
  const root=await mkdtemp(join(tmpdir(),'agent-source-file-state-'));
  const file=join(root,target);
  let server,child,timer;
  const requests=[];
  try {
    if(initial!==null)await writeFile(file,initial);
    server=createServer(async(req,res)=>{
      const input=[];
      for await(const chunk of req)input.push(chunk);
      requests.push(JSON.parse(Buffer.concat(input).toString('utf8')));
      const round=requests.length;
      // Concurrent external edit between original Read and next model tool.
      if(round===2 && mutate)await mutate(file);
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(steps[round-1]?toolStream(steps[round-1]):answer());
    });
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen(0,'127.0.0.1',resolve);
    });
    child=spawn(process.execPath,[cli,'--print','--provider','deepseek',
      '--max-retries','0','--max-turns','8','--compact-threshold','0',
      '--cwd',root,'--allowedTools','Read','--allowedTools','Write',
      '--allowedTools','Edit',
      '--base-url','http://127.0.0.1:'+server.address().port+'/anthropic',
      'Perform the intended source Read, Edit and Write operation.'],{
      env:{...process.env,DEEPSEEK_API_KEY:'local-source-test'},
      stdio:['ignore','pipe','pipe'],
    });
    const output=[],errors=[];
    child.stdout.on('data',d=>output.push(d));
    child.stderr.on('data',d=>errors.push(d));
    timer=setTimeout(()=>child.kill('SIGKILL'),23000);
    const [status,signal]=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',(code,sig)=>resolve([code,sig]));
    });
    const out=Buffer.concat(output).toString('utf8')+
      Buffer.concat(errors).toString('utf8');
    assert.equal(signal,null,out);
    assert.equal(status,0,out);
    assert.match(out,/ORIGINAL_FILE_READ_STATE_VERIFIED/);
    assert.equal(requests.length,steps.length+1,out);
    const toolBlocks=requests.slice(1).map(request=>
      request.messages.at(-1).content[0]);
    for(const [index,result] of toolBlocks.slice(0,steps.length).entries()) {
      assert.equal(result.tool_use_id,steps[index].id,'original source tool ID must be retained');
      if(expected.errors?.[index]) {
        assert.equal(result.is_error,true,JSON.stringify(result));
        assert.match(result.content,expected.errors[index]);
      }else{
        assert.notEqual(result.is_error,true,JSON.stringify(result));
      }
    }
    assert.equal(await readFile(file,'utf8'),expected.content);
  }finally{
    if(timer)clearTimeout(timer);
    if(child?.exitCode===null)child.kill('SIGKILL');
    server?.closeAllConnections?.();
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}

const cases=[
  {name:'Read then Edit uses original readFileState',
    steps:[R('read1'),E('edit1')],expected:{content:'beta'}},
  {name:'Edit without Read refuses pre-existing target',
    steps:[E('unread-edit')],expected:{content:'alpha',errors:[
      /File has not been read yet/,
    ]}},
  {name:'partial Read does not authorize Edit',
    initial:'alpha\\nsecond',steps:[
      R('partial-read',{file_path:'existing.txt',offset:0,limit:1}),
      E('partial-edit'),
    ],expected:{content:'alpha\\nsecond',errors:{
      1:/File has not been read yet/,
    }}},
  {name:'external Edit between Read and Write is rejected',
    steps:[R('read-external'),E('edit-external')],
    mutate:file=>writeFile(file,'external'),
    expected:{content:'external',errors:{1:/unexpectedly modified/}}},
  {name:'Write to existing file without Read is rejected',
    steps:[W('unread-write')],expected:{content:'alpha',errors:[
      /File has not been read yet/,
    ]}},
  {name:'Read then Write updates source state for subsequent Edit',
    steps:[R('read-write'),W('write-after-read'),E('edit-after-write',{
      file_path:'existing.txt',old_string:'beta',new_string:'gamma',
    })],expected:{content:'gamma'}},
  {name:'new file Write then Edit needs no preceding Read',
    initial:null,target:'created.txt',steps:[
      W('create',{file_path:'created.txt',content:'alpha'}),
      E('edit-created',{file_path:'created.txt',old_string:'alpha',new_string:'beta'}),
    ],expected:{content:'beta'}},
  {name:'external edit between Read and Write rejects overwrite',
    steps:[R('read-before-overwrite'),W('write-stale')],
    mutate:file=>writeFile(file,'external'),expected:{
      content:'external',errors:{1:/unexpectedly modified/},
    }},
  {name:'mtime-only change with unchanged content permits original Edit fallback',
    steps:[R('read-mtime'),E('edit-mtime')],
    mutate:async file=>{
      const info=await stat(file);
      await utimes(file,info.atime,new Date(info.mtimeMs+3000));
    },expected:{content:'beta'}},
  {name:'same-length changed content detected even with coarse mtime',
    steps:[R('read-coarse'),E('edit-coarse')],
    mutate:async file=>{
      const info=await stat(file);
      await writeFile(file,'ALPHA');
      await utimes(file,info.atime,info.mtime);
    },expected:{content:'ALPHA',errors:{1:/unexpectedly modified/}}},
];
for(const spec of cases){
  test('real CLI 2.1.88 FileReadState: '+spec.name,{timeout:30000},
    async()=>exercise(spec));
}
