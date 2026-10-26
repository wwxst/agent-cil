import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiskTaskOutput, TaskOutput, getTaskOutputPath, getTaskOutput,
} from '../src/legacy-task-output.js';
import { createBuiltinTools } from '../src/index.js';

test('original DiskTaskOutput writes and flushes multiple output batches without overwriting earlier bytes',async()=>{
  const id=randomUUID();
  const output=new DiskTaskOutput(id);
  output.append('first part\n');
  await output.flush();
  output.append('second part 🌍\n');
  await output.flush();
  output.append('third part\n');
  await output.flush();
  assert.equal(await readFile(output.path,'utf8'),
    'first part\nsecond part 🌍\nthird part\n');
  assert.equal(output.path,getTaskOutputPath(id));
  assert.equal(await getTaskOutput(id), 'first part\nsecond part 🌍\nthird part\n');
  if(process.platform!=='win32') {
    const mode=(await stat(output.path)).mode & 0o777;
    assert.equal(mode & 0o077,0,'output files must be owner-private on POSIX');
  }
});

test('ported TaskOutput pipe mode spills both streams and retains multibyte content',async()=>{
  const output=new TaskOutput(randomUUID(),null,false,48);
  output.writeStdout('header\n');
  output.writeStderr('error 🌍\n');
  output.writeStdout('x'.repeat(65)+'\n');
  output.writeStderr('post-overflow stderr 🎯\n');
  await output.flush();
  assert.equal(output.isOverflowed,true);
  assert.match(await output.getStdout(),/Full output saved to/);
  assert.equal(output.getStderr(),'');
  const text=await readFile(output.path,'utf8');
  assert.equal(text,
    'header\n[stderr] error 🌍\n'+'x'.repeat(65)+'\n'+
    '[stderr] post-overflow stderr 🎯\n');
  assert.equal(output.outputFileSize,Buffer.byteLength(text));
});

test('real registered Bash writes full 1MiB+ stdout/stderr to source TaskOutput file on Windows and Linux', {
  timeout:24000,
},async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-cil-task-output-'));
  const script=join(root,'big-output.cjs');
  try {
    await writeFile(script,
      'process.stdout.write("A".repeat(800000));'+
      'process.stderr.write("B".repeat(450000));'+
      'process.stdout.write("output-complete\\n");');
    const command='"'+process.execPath.replaceAll('"','')+'" "'+
      script.replaceAll('"','')+'"';
    const bash=(await createBuiltinTools({workspace:root})).get('Bash');
    const result=await bash.execute({command,timeout_ms:10000});
    assert.equal(result.exit_code,0);
    assert.equal(result.error,undefined);
    assert.match(result.stdout,/Output truncated/);
    assert.match(result.outputTaskId,/^[0-9a-f-]{36}$/i);
    assert.equal(result.outputFilePath,getTaskOutputPath(result.outputTaskId));
    const stored=await readFile(result.outputFilePath,'utf8');
    assert.ok(stored.includes('A'.repeat(10000)));
    assert.ok(stored.includes('B'.repeat(10000)));
    assert.ok(stored.includes('[stderr] '));
    assert.ok(stored.includes('output-complete'));
    assert.equal(result.outputFileSize,Buffer.byteLength(stored));
    assert.ok(Buffer.byteLength(result.stdout)<30000);
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:7,retryDelay:120});
  }
});
