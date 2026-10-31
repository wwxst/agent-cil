import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('original PostToolUse continue:false stops after result checkpoint with meta context retained', {
  timeout: 20000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-cil-original-post-stop-'));
  try {
    await writeFile(join(cwd, 'context-hook.cjs'),
      "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{"+
      "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',"+
      "additionalContext:'Checked the output'}}));});");
    await writeFile(join(cwd, 'stop-hook.cjs'),
      "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{"+
      "require('node:fs').writeFileSync('observed.json',s);"+
      "console.log(JSON.stringify({continue:false,stopReason:'Stop after validation',"+
      "hookSpecificOutput:{hookEventName:'PostToolUse'}}));});");
    let toolCalls = 0, modelRequests = 0;
    const tools = new ToolRegistry();
    tools.register({ name: 'Verify', description: 'Verifies one item',
      execute: async () => { toolCalls++; return { valid: true }; },
    });
    const loop = new AgentLoop({
      tools,
      hookWorkspace: cwd,
      postToolUseHooks: [
        { matcher: 'Verify', type: 'command',
          command: 'node context-hook.cjs', timeout: 6 },
        { matcher: 'Verify', type: 'command',
          command: 'node stop-hook.cjs', timeout: 6 },
      ],
      permissionPolicy: async () => ({ behavior: 'allow' }),
      model: { async *stream() {
        modelRequests++;
        if (modelRequests !== 1) {
          throw new Error('Original stop hook must suppress a second model call');
        }
        yield { type: 'tool_use', id: 'verify-stop', name: 'Verify', input: {} };
        yield { type: 'message_end', stopReason: 'tool_use' };
      } },
    });
    const checkpoints = [];
    loop.on('turnFinished', event => checkpoints.push(event));
    const result = await loop.run({ input: 'verify then stop' });
    assert.equal(result.stopReason, 'hook_stopped');
    assert.equal(result.stopMessage, 'Stop after validation');
    assert.equal(toolCalls, 1);
    assert.equal(modelRequests, 1);
    assert.equal(result.messages.length, 3);
    const blocks = result.messages[2].content;
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].tool_use_id, 'verify-stop');
    assert.equal(blocks[0].is_error, undefined);
    assert.match(blocks[1].text, /Verify hook additional context: Checked the output/);
    assert.match(blocks[2].text, /Verify hook stopped continuation: Stop after validation/);
    assert.equal(result.hookMessages.length, 2);
    assert.equal(checkpoints.length, 1);
    assert.deepEqual(checkpoints[0].committedMessages, result.messages);
    const observed = JSON.parse(await readFile(join(cwd,'observed.json'),'utf8'));
    assert.equal(observed.tool_use_id, 'verify-stop');
    assert.equal(observed.tool_response.valid, true);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
