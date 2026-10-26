import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools, createCliPermissionPolicy, createCliPermissionContext } from '../src/index.js';
import { permissionRuleValueFromString } from '../../runtime/src/legacy-permissions/permission-rule-parser.js';
import { isReadableInternalTaskOutputPath } from '../src/legacy-task-output.js';

const makeWorkspace=()=>mkdtemp(join(tmpdir(),'agent-cil-trusted-output-'));

test('completed Bash output is readable in bounded sections by real Read; no blanket temp or cross-workspace permission', {
  timeout:24000,
},async()=>{
  const workspace=await makeWorkspace(),other=await makeWorkspace();
  let outputPath;
  try{
    const tools=await createBuiltinTools({workspace});
    const read=tools.get('Read'), bash=tools.get('Bash');
    const script=join(workspace,'many-lines.cjs');
    await writeFile(script,[
      "for(let i=0;i<22000;i++)process.stdout.write('ROW_'+String(i).padStart(5,'0')+' original recorded output\\n');",
      "process.stdout.write('END_OF_ORIGINAL_LOG\\n');",
    ].join('\n'));
    const command='"'+process.execPath.replaceAll('"','')+'" "'+script.replaceAll('"','')+'"';
    const result=await bash.execute({command,timeout_ms:15000});
    assert.equal(result.exit_code,0);
    assert.equal(result.error,undefined);
    outputPath=result.outputFilePath;
    assert.ok(outputPath,'a large Bash output must be persisted');
    assert.equal(isReadableInternalTaskOutputPath(workspace,outputPath),true);
    assert.equal(isReadableInternalTaskOutputPath(other,outputPath),false);
    const policy=createCliPermissionPolicy({workspace});
    assert.equal((await policy({name:'Read',input:{file_path:outputPath,offset:19000,limit:2}})).behavior,'allow');
    const selected=await read.execute({file_path:outputPath,offset:19000,limit:2});
    assert.match(selected,/ROW_19000 original recorded output/);
    assert.match(selected,/ROW_19001 original recorded output/);
    assert.doesNotMatch(selected,/ROW_18999/);
    await assert.rejects(read.execute({file_path:outputPath}),
      /exceeds the 1 MiB read limit/,
      'full large file reads retain the original 1 MiB safety bound');
    const arbitrary=join(tmpdir(),'not-this-task-output-'+Date.now()+'.txt');
    assert.equal((await policy({name:'Read',input:{file_path:arbitrary}})).behavior,'deny');
    await assert.rejects(read.execute({file_path:arbitrary}),/escapes the workspace/);
    const foreign=createCliPermissionPolicy({workspace:other});
    assert.equal((await foreign({name:'Read',input:{file_path:outputPath}})).behavior,'deny');
    const foreignTools=await createBuiltinTools({workspace:other});
    await assert.rejects(foreignTools.get('Read').execute({file_path:outputPath}),
      /escapes the workspace/);
    const denyContext=createCliPermissionContext({
      permissionRules:{deny:[permissionRuleValueFromString('Read')]},
    });
    const explicitDeny=createCliPermissionPolicy({workspace,permissionContext:denyContext});
    assert.equal((await explicitDeny({name:'Read',input:{file_path:outputPath}})).behavior,'deny',
      'explicit deny rules still override trusted internal read allowlist');
  }finally{
    await rm(workspace,{recursive:true,force:true,maxRetries:7,retryDelay:150});
    await rm(other,{recursive:true,force:true,maxRetries:7,retryDelay:150});
  }
});

test('completed Bash Read capability refuses output path replacement, including symlinks', {
  timeout:20000,
},async()=>{
  const workspace=await makeWorkspace();
  try{
    const script=join(workspace,'larger.cjs');
    await writeFile(script,'process.stdout.write("S".repeat(1100000));');
    const tools=await createBuiltinTools({workspace});
    const result=await tools.get('Bash').execute({
      command:'"'+process.execPath.replaceAll('"','')+'" "'+script.replaceAll('"','')+'"',
      timeout_ms:10000,
    });
    assert.equal(result.exit_code,0);
    const original=result.outputFilePath;
    const displaced=original+'.original';
    const foreign=join(workspace,'forged.txt');
    await writeFile(foreign,'ATTACKER_FORGED_TASK_OUTPUT');
    await rename(original,displaced);
    try {
      await writeFile(original,'ATTACKER_FORGED_TASK_OUTPUT');
      await assert.rejects(tools.get('Read').execute({file_path:original,offset:0,limit:1}),
        /replaced|identity|verified/);
      await rm(original,{force:true});
      try {
        await symlink(foreign,original,'file');
        await assert.rejects(tools.get('Read').execute({file_path:original,offset:0,limit:1}),
          /replaced|identity|verified/);
      }catch(error) {
        if(!['EPERM','EACCES','ENOSYS'].includes(error?.code))throw error;
      }
    }finally {
      await rm(original,{force:true});
      await rename(displaced,original);
    }
    const text=await tools.get('Read').execute({file_path:original,offset:0,limit:1});
    assert.ok(text.startsWith('SSSS'),'restoring the authentic inode must restore safe access');
  }finally{
    await rm(workspace,{recursive:true,force:true,maxRetries:7,retryDelay:150});
  }
});
