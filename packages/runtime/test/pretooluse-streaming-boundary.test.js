import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('original scheduler never starts side-effecting PreToolUse command Hook before completed model turn', {
  timeout: 20000,
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-hook-stream-gate-'));
  try {
    await writeFile(join(workspace, 'hook.cjs'),
      'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}));');
    let readCalls = 0, modelRounds = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'Read', description: 'Workspace read fixture',
      canRunDuringStream: true, isConcurrencySafe: () => true,
      call: async () => {
        readCalls++;
        return { data: 'read done' };
      },
      mapToolResultToToolResultBlockParam: (data, toolUseId) => ({
        type: 'tool_result', tool_use_id: toolUseId, content: data,
      }),
    });
    const permissionPolicy = async () => ({ behavior: 'allow', reason: 'Read-only workspace operation.' });
    Object.defineProperty(permissionPolicy, 'supportsStreamingPreflight', { value: true });
    Object.defineProperty(permissionPolicy, 'isBuiltinCliPolicy', { value: true });
    const loop = new AgentLoop({
      model: {
        async *stream({ messages }) {
          modelRounds++;
          if (modelRounds === 1) {
            yield { type: 'tool_use', id: 'read-with-hook', name: 'Read', input: {} };
            // Original early stream mode WOULD start the tool at block_stop;
            // command Hooks run shell processes and are not rollbackable.
            await new Promise(resolve => setTimeout(resolve, 500));
            assert.equal(readCalls, 0, 'Hook configuration must defer tool to committed message_end');
            yield { type: 'message_end', stopReason: 'tool_use' };
          } else {
            assert.equal(readCalls, 1);
            const toolResult = messages.at(-1).content[0];
            assert.equal(toolResult.tool_use_id, 'read-with-hook');
            assert.equal(toolResult.content, 'read done');
            yield { type: 'text_delta', text: 'completed after Hook' };
            yield { type: 'message_end', stopReason: 'end_turn' };
          }
        },
      },
      tools, permissionPolicy, maxTurns: 3, hookWorkspace: workspace,
      preToolUseHooks: [{
        type: 'command', matcher: 'Read', command: 'node hook.cjs', timeout: 6,
      }],
    });
    const result = await loop.run({ input: 'read once' });
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(modelRounds, 2);
    assert.equal(readCalls, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
