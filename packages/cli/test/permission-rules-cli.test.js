import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, createCliPermissionContext, createCliPermissionPolicy } from '../src/index.js';
import { bashToolCheckExactMatchPermission } from '../../runtime/src/legacy-permissions/bash-exact-permission.js';
import { permissionRuleValueToString } from '../../runtime/src/legacy-permissions/permission-rule-parser.js';
import { parsePermissionRule, matchWildcardPattern } from '../../runtime/src/legacy-permissions/shell-rule-matching.js';

const cli = process.env.AGENT_CIL_TEST_EXECUTABLE ??
  fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, props = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...props }) + '\n\n';
function toolStream(id, input) {
  return frame('message_start', { message: { usage: { input_tokens: 30 } } }) +
    frame('content_block_start', { index: 0,
      content_block: { type: 'tool_use', id, name: 'Write', input: {} } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 14 } }) +
    frame('message_stop');
}
function answerStream() {
  return frame('message_start', { message: { usage: { input_tokens: 30 } } }) +
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Permission rule checked.' } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }) +
    frame('message_stop');
}
test('original permissions reject unsupported content-specific rules at CLI boundary', () => {
  const accepted = parseArgs(['--allowedTools', 'Write', '--disallowedTools=Read', '--askTools', 'Bash', '-p', 'hello']);
  assert.deepEqual(accepted.permissionRules, {
    allow: [{ toolName: 'Write' }],
    deny: [{ toolName: 'Read' }],
    ask: [{ toolName: 'Bash' }],
  });
  assert.throws(() => parseArgs(['--allowedTools', 'Bash(git push:*)']), /wildcard\/prefix/);
  assert.throws(() => parseArgs(['--allowedTools', 'mcp__server__Read']), /MCP/);
  assert.throws(() => parseArgs(['--allowedTools', 'Task']), /built-in/);
});

test('original CLI rule precedence is deny > ask > allow even with acceptEdits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cil-rule-policy-'));
  try {
    const ctx = createCliPermissionContext({
      allowEdits: true,
      permissionRules: {
        allow: [{ toolName: 'Write' }],
        ask: [{ toolName: 'Write' }],
        deny: [{ toolName: 'Write' }],
      },
    });
    const policy = createCliPermissionPolicy({ workspace: root, permissionContext: ctx });
    const decision = await policy({ name: 'Write', input: { file_path: 'file.txt', content: 'test' } });
    assert.equal(decision.behavior, 'deny');
    const outside = await policy({ name: 'Write', input: { file_path: '../outside.txt', content: 'x' } });
    assert.equal(outside.behavior, 'deny');
    assert.match(outside.reason, /not authorized/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real installed CLI honors original allow/deny/ask rules without bypassing path safety', {
  timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cil-original-rules-'));
  async function scenario(extra, expected, inputPath = 'result.txt') {
    const received = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(received.length === 1
        ? toolStream('write-' + expected, { file_path: inputPath, content: expected })
        : answerStream());
    });
    let child, watchdog;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      child = spawn(process.execPath, [
        cli, '--print', '--provider', 'deepseek',
        '--cwd', root, '--max-turns', '3', '--max-retries', '0',
        '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
        ...extra, 'Test permission priority.',
      ], { env: { ...process.env, DEEPSEEK_API_KEY: 'local-only' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [], stderr = [];
      child.stdout.on('data', value => stdout.push(value));
      child.stderr.on('data', value => stderr.push(value));
      watchdog = setTimeout(() => child.kill('SIGKILL'), 18000);
      const [code, signal] = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, sig) => resolve([status, sig]));
      });
      assert.equal(signal, null, Buffer.concat(stderr).toString('utf8'));
      assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
      assert.match(Buffer.concat(stdout).toString('utf8'), /Permission rule checked/);
      assert.equal(received.length, 2);
      const result = received[1].messages.at(-1).content[0];
      assert.equal(result.tool_use_id, 'write-' + expected);
      return result;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
      server.closeAllConnections?.();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
  try {
    const allow = await scenario(['--allowedTools', 'Write'], 'allow');
    assert.equal(allow.is_error, undefined);
    assert.equal((await readFile(join(root, 'result.txt'), 'utf8')), 'allow');
    const deny = await scenario(['--allow-edits', '--disallowedTools', 'Write'], 'deny');
    assert.equal(deny.is_error, true);
    assert.equal((await readFile(join(root, 'result.txt'), 'utf8')), 'allow');
    const ask = await scenario(['--allowedTools', 'Write', '--askTools', 'Write'], 'ask');
    assert.equal(ask.is_error, true, 'ask rule prevents headless automatic write');
    const unsafe = await scenario(['--allowedTools', 'Write'], 'unsafe', '../escape.txt');
    assert.equal(unsafe.is_error, true, 'allow rule cannot override workspace confinement');
    await assert.rejects(stat(join(root, '..', 'escape.txt')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('verbatim source shell-rule parser preserves prefix, exact and wildcard semantics', () => {
  assert.deepEqual(parsePermissionRule('git:*'), { type: 'prefix', prefix: 'git' });
  assert.deepEqual(parsePermissionRule('git status'), { type: 'exact', command: 'git status' });
  assert.deepEqual(parsePermissionRule('git *'), { type: 'wildcard', pattern: 'git *' });
  assert.equal(matchWildcardPattern('git *', 'git'), true);
  assert.equal(matchWildcardPattern('git *', 'git status'), true);
  assert.equal(matchWildcardPattern('git *', 'git-lfs status'), false);
  assert.equal(matchWildcardPattern('npm run *', 'npm run'), true);
  assert.equal(matchWildcardPattern('npm run *', 'npm run lint'), true);
  assert.equal(matchWildcardPattern('npm * run *', 'npm run'), false);
});

test('source prefix/wildcard Bash deny and ask rules are restrictive, not broad automatic allow', () => {
  const parsed = parseArgs([
    '--disallowedTools', 'Bash(git push:*)',
    '--disallowedTools', 'Bash(node *)',
    '--askTools', 'Bash(npm run *)',
  ]);
  const ctx = createCliPermissionContext({
    permissionRules: {
      ...parsed.permissionRules,
      allow: [{ toolName: 'Bash', ruleContent: 'FOO=1 node --version' }],
    },
  });
  for (const command of ['git push origin main', 'node --version', 'xargs git push --force']) {
    assert.equal(bashToolCheckExactMatchPermission({command},ctx).behavior,'deny',command);
  }
  assert.equal(bashToolCheckExactMatchPermission({command:'npm run build'},ctx).behavior,'ask');
  assert.equal(bashToolCheckExactMatchPermission({
    command:'FOO=1 node --version',
  },ctx).behavior,'deny','original aggressive environment stripping must enforce deny');
  assert.equal(bashToolCheckExactMatchPermission({
    command:'node-not-the-prefix --version',
  },ctx).behavior,'ask');
  // Original 2.1.88 filterRulesByContentsMatchingInput repeatedly strips
  // interleaved SAFE_WRAPPER_PATTERNS and leading env assignments for
  // restrictive rules, but never broadens automatic allow matches.
  for (const command of [
    'FOO=bar node --version',
    "FOO='bar' node --version",
    'nohup node --version',
    'timeout 5 node --version',
    'nice -n 5 node --version',
    'nohup FOO=bar timeout 5 node --version',
    'TZ=UTC nohup FOO=bar timeout 5 node --version',
  ]) {
    assert.equal(bashToolCheckExactMatchPermission({ command },ctx).behavior,'deny',command);
  }
  // Original Bash wildcard "node *" does not special-case xargs.
  // In contrast the original legacy prefix "node:*" explicitly supports
  // xargs node: compare the two without loosening production matching.
  assert.equal(bashToolCheckExactMatchPermission({
    command:'xargs node --version',
  },ctx).behavior,'ask');
  const prefixContext = createCliPermissionContext({
    permissionRules:{allow:[],deny:[{toolName:'Bash',ruleContent:'node:*'}],ask:[]},
  });
  assert.equal(bashToolCheckExactMatchPermission({
    command:'xargs node --version',
  },prefixContext).behavior,'deny');
  for (const command of [
    'NODE_OPTIONS=$(echo injected) node --version',
    'timeout -k$(id) 5 node --version',
    'FOO=bar\\nnode --version',
  ]) {
    assert.equal(bashToolCheckExactMatchPermission({ command },ctx).behavior,'ask',command);
  }
  assert.throws(() => parseArgs(['--allowedTools','Bash(git push:*)']),/wildcard\/prefix/);
  assert.throws(() => parseArgs(['--allowedTools','Bash(npm run *)']),/wildcard\/prefix/);
});

test('original Bash exact rule only matches the entire command; deny > ask > allow', () => {
  const parsed = parseArgs([
    '--allowedTools', 'Bash(node --version)',
    '--disallowedTools', 'Bash(node --version)',
    '--askTools', 'Bash(node --version)', '-p', 'hi',
  ]);
  const ctx = createCliPermissionContext({ permissionRules: parsed.permissionRules });
  assert.equal(bashToolCheckExactMatchPermission({ command: 'node --version' }, ctx).behavior, 'deny');
  assert.equal(bashToolCheckExactMatchPermission({ command: 'node --version; echo injected' }, ctx).behavior, 'ask');
  for (const value of [
    'Bash(npm run:*)', 'Bash(node *)', 'Bash(*)', 'Bash()', 'Bash(node --version)extra',
    'Write(file.txt)', 'Bash( node --version)',
  ]) {
    assert.throws(() => parseArgs(['--allowedTools', value]), /built-in|wildcards|MCP/);
  }
});

function bashToolStream(id, command) {
  return frame('message_start', { message: { usage: { input_tokens: 30 } } }) +
    frame('content_block_start', { index: 0,
      content_block: { type: 'tool_use', id, name: 'Bash', input: {} } }) +
    frame('content_block_delta', { index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command }) } }) +
    frame('content_block_stop', { index: 0 }) +
    frame('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 14 } }) +
    frame('message_stop');
}

test('packed CLI Bash permission chain: exact allow, deny, ask, whole ask, unmatched fallback', {
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-cil-bash-rule-'));
  async function scenario(flags, command) {
    const requests = [];
    const id = 'bash-permission';
    const server = createServer(async (req,res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(requests.length === 1 ? bashToolStream(id, command) : answerStream());
    });
    let child, watchdog;
    try {
      await new Promise((resolve,reject) => {
        server.once('error', reject);
        server.listen(0,'127.0.0.1',resolve);
      });
      child = spawn(process.execPath, [
        cli, '--print', '--provider', 'deepseek',
        '--cwd', root, '--max-turns', '3', '--max-retries', '0',
        '--base-url', 'http://127.0.0.1:' + server.address().port + '/anthropic',
        ...flags, 'Test Bash command-specific permissions',
      ], { env: {...process.env, DEEPSEEK_API_KEY:'local-only'},
        stdio:['ignore','pipe','pipe'] });
      const out=[],err=[];
      child.stdout.on('data', value=>out.push(value));
      child.stderr.on('data',value=>err.push(value));
      watchdog=setTimeout(()=>child.kill('SIGKILL'),18000);
      const [code,signal]=await new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('close',(status,sig)=>resolve([status,sig]));
      });
      assert.equal(signal,null,Buffer.concat(err).toString('utf8'));
      assert.equal(code,0,Buffer.concat(err).toString('utf8'));
      assert.equal(requests.length,2);
      assert.match(Buffer.concat(out).toString('utf8'),/Permission rule checked/);
      const result=requests[1].messages.at(-1).content.find(block=>
        block?.type==='tool_result' && block.tool_use_id===id);
      assert.ok(result,'model must get exactly one matching Bash tool_result');
      assert.equal(requests[1].messages.at(-1).content.filter(block=>
        block?.type==='tool_result' && block.tool_use_id===id).length,1);
      return result;
    } finally {
      if(watchdog)clearTimeout(watchdog);
      if(child && child.exitCode===null && !child.killed)child.kill('SIGKILL');
      server.closeAllConnections?.();
      if(server.listening)await new Promise(resolve=>server.close(resolve));
    }
  }
  try {
    const allowed=await scenario(['--allowedTools','Bash(node --version)'],'node --version');
    assert.notEqual(allowed.is_error,true);
    assert.match(JSON.stringify(allowed.content),/v\d+/);
    // Original tool execution must not replay a side effect: one real Node
    // shell action, one ordered result and one follow-up model request.
    // Escape parentheses with the unchanged 2.1.88 rule serializer.
    const sideEffect = 'node -e "require(\'fs\').appendFileSync(\'permission-once.txt\',\'x\')"';
    const serializedRule = permissionRuleValueToString({
      toolName:'Bash',ruleContent:sideEffect,
    });
    const executed = await scenario(['--allowedTools',serializedRule],sideEffect);
    assert.notEqual(executed.is_error,true);
    assert.equal(await readFile(join(root,'permission-once.txt'),'utf8'),'x');

    // A whole-tool allow must not execute a denied prefix subcommand with a
    // real side effect. Also ensure compound commands fail closed instead of
    // bypassing a deny hidden after an otherwise harmless command.
    const forbidden = 'node -e "require(\'fs\').appendFileSync(\'blocked.txt\',\'x\')"';
    const denied = await scenario([
      '--allowedTools','Bash', '--disallowedTools','Bash(node:*)',
    ], forbidden);
    assert.equal(denied.is_error,true);
    await assert.rejects(stat(join(root,'blocked.txt')), /ENOENT/);
    const compounded = await scenario([
      '--allowedTools','Bash', '--disallowedTools','Bash(node:*)',
    ], 'echo harmless && ' + forbidden);
    assert.equal(compounded.is_error,true);
    await assert.rejects(stat(join(root,'blocked.txt')), /ENOENT/);

    for(const [flags, command] of [
      [['--disallowedTools','Bash(node --version)','--allowedTools','Bash(node --version)'], 'node --version'],
      [['--askTools','Bash(node --version)','--allowedTools','Bash(node --version)'], 'node --version'],
      [['--askTools','Bash','--allowedTools','Bash(node --version)'], 'node --version'],
      [['--allowedTools','Bash(node --version)'], 'node --version && echo unsafe'],
      [['--allowedTools','Bash','--disallowedTools','Bash(node --version)'], 'FOO=1 node --version'],
      [['--allowedTools','Bash','--disallowedTools','Bash(node:*)'], 'nohup FOO=bar timeout 5 node --version'],
      [['--allowedTools','Bash','--askTools','Bash(node:*)'], 'nohup FOO=bar timeout 5 node --version'],
      [['--allowedTools','Bash','--disallowedTools','Bash(node:*)'], 'node --version'],
      [['--allowedTools','Bash','--disallowedTools','Bash(node *)'], 'node --version'],
      [['--allowedTools','Bash','--askTools','Bash(node *)'], 'node --version'],
      [['--allowedTools','Bash(FOO=1 node --version)','--disallowedTools','Bash(node:*)'], 'FOO=1 node --version'],

    ]) {
      const rejected=await scenario(flags,command);
      assert.equal(rejected.is_error,true,JSON.stringify({flags,command,rejected}));
    }
  } finally {
    await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
});
