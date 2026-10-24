#!/usr/bin/env node
// Manual credentialed acceptance. Uses the production adapter, loop and CLI tools.
// Only structural metadata is emitted; headers, reasoning and signatures stay private.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AnthropicMessagesAdapter } from '../packages/runtime/src/anthropic-messages-adapter.js';
import { AgentLoop } from '../packages/runtime/src/agent-loop.js';
import { createAutoCompact } from '../packages/runtime/src/legacy-compact/auto-compact.js';
import { createBuiltinTools, createCliPermissionContext, createCliPermissionPolicy } from '../packages/cli/src/index.js';

const key = process.env.DEEPSEEK_API_KEY;
assert.ok(key, 'Set DEEPSEEK_API_KEY in the environment.');
const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-extended-'));
const report = { model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/anthropic',
  node: process.version, platform: process.platform, requests: [], usage: [], tools: [], compactions: [], thinking: [], approvals: [] };
const protectedBlocks = messages => messages.flatMap(m => Array.isArray(m.content)
  ? m.content.filter(b => b.type === 'thinking') : []);
let previous = [];
const model = new AnthropicMessagesAdapter({ apiKey: key, model: report.model,
  baseUrl: report.endpoint, maxTokens: 4096, maxRetries: 1,
  fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    const blocks = protectedBlocks(body.messages);
    // Retained thinking must be byte-for-byte identical, including any signature.
    for (const block of blocks) assert.ok(previous.some(old => isDeepStrictEqual(old, block)),
      'Outgoing thinking was changed or fabricated');
    const response = await fetch(url, options);
    report.requests.push({ status: response.status, messages: body.messages.length,
      bytes: Buffer.byteLength(options.body), tools: body.tools?.length ?? 0,
      thinkingBlocks: blocks.length });
    return response;
  } });
const compact = createAutoCompact({ thresholdTokens: 6000 });
const policy = createCliPermissionPolicy({ workspace,
  permissionContext: createCliPermissionContext({ allowEdits: true }) });
const loop = new AgentLoop({ model, tools: await createBuiltinTools({ workspace }),
  compactContext: context => compact.compact(context), permissionPolicy: policy,
  // Explicit test operator approval, restricted to a single harmless command.
  approvalHandler: async ({ name, input }) => {
    const approved = name === 'Bash' && input.command === 'node verify.cjs';
    report.approvals.push({ name, approved });
    return { approved };
  }, maxTurns: 16 });
loop.on('usage', e => report.usage.push(e.usage));
loop.on('toolCallStarted', e => report.tools.push(e.toolName));
loop.on('contextCompacted', e => report.compactions.push({ before: e.beforeCount,
  after: e.afterCount, estimatedTokens: e.estimatedTokens, compactedTokens: e.compactedTokens }));
loop.on('assistantMessage', ({ message }) => {
  const blocks = protectedBlocks([message]);
  previous.push(...structuredClone(blocks));
  report.thinking.push(...blocks.map(b => ({ chars: b.thinking.length,
    signaturePresent: typeof b.signature === 'string', signatureChars: b.signature?.length ?? 0 })));
});
try {
  await writeFile(join(workspace, 'math.cjs'), 'module.exports = (a,b) => a-b;\n');
  await writeFile(join(workspace, 'verify.cjs'), "const fs=require('fs'); require('assert').equal(require('./math.cjs')(2,3),5); fs.appendFileSync('executions.txt','once\\n'); console.log('VERIFIED');\n");
  for (let n = 1; n <= 4; n++) await writeFile(join(workspace, `notes${n}.txt`),
    `Task continuity marker: ORCHID-741. Notes batch ${n}.\n` +
    Array.from({ length: 900 }, (_, i) => `Diagnostic ${n}-${i}: completed workspace inspection; retain task goal and marker.\n`).join(''));
  let messages = [];
  for (let n = 1; n <= 4; n++) {
    const result = await loop.run({ messages, input: `Use Read on notes${n}.txt, then acknowledge batch ${n}. Retain the marker for the final task. Do not read other files yet.`, signal: AbortSignal.timeout(120000) });
    assert.equal(result.stopReason, 'end_turn');
    messages = result.messages;
  }
  const result = await loop.run({ messages, input:
    'Execute these tools sequentially: Read math.cjs; Edit a-b to a+b exactly once; Read math.cjs again; Bash with exactly node verify.cjs once. Do not modify verify.cjs. Finish by stating the continuity marker from the earlier notes and command result.',
    signal: AbortSignal.timeout(120000) });
  assert.equal(result.stopReason, 'end_turn');
  assert.match(JSON.stringify(result.finalMessage), /ORCHID-741/);
  assert.equal(await readFile(join(workspace, 'math.cjs'), 'utf8'), 'module.exports = (a,b) => a+b;\n');
  assert.equal(await readFile(join(workspace, 'executions.txt'), 'utf8'), 'once\n');
  assert.equal(report.tools.filter(t => t === 'Edit').length, 1);
  assert.equal(report.tools.filter(t => t === 'Bash').length, 1);
  assert.ok(report.compactions.length > 0, 'No automatic compaction occurred');
  assert.ok(report.thinking.some(b => b.chars > 0), 'No live thinking observed');
  assert.ok(report.usage.some(u => u.input_tokens > 0), 'No input token usage observed');
  report.result = 'PASS';
  report.context400 = 'UNVERIFIED: no genuine provider context overflow triggered';
  report.retryReplay = 'UNVERIFIED live: no transport/context retry occurred; see deterministic suite';
} catch (error) {
  report.result = 'FAIL';
  report.error = String(error.message).replaceAll(key, '[REDACTED]');
  process.exitCode = 1;
} finally {
  console.log(JSON.stringify(report, null, 2));
  await rm(workspace, { recursive: true, force: true });
}
