import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseArgs } from '../src/index.js';

const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const frame = (type, fields = {}) =>
  'event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n';
const finishStream = text => [
  frame('message_start', { message: { usage: { input_tokens: 2 } } }),
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  frame('content_block_stop', { index: 0 }),
  frame('message_delta', { delta: { stop_reason: 'end_turn' } }),
  frame('message_stop'),
].join('');

test('config subcommand parses only supported model operations', () => {
  assert.deepEqual(parseArgs(['config']), { mode: 'config-help' });
  assert.deepEqual(parseArgs(['config', '--help']), { mode: 'config-help' });
  assert.deepEqual(parseArgs(['config', 'show']), { mode: 'config-show' });
  assert.deepEqual(parseArgs(['config', 'get', 'model']), { mode: 'config-get-model' });
  assert.deepEqual(parseArgs(['config', 'set', 'model', 'opus']), {
    mode: 'config-set-model', model: 'opus',
  });
  assert.deepEqual(parseArgs(['config', 'unset', 'model']), { mode: 'config-unset-model' });
  assert.throws(() => parseArgs(['config', 'set', 'model']), /Usage: agent-cil config/);
  assert.throws(() => parseArgs(['config', 'set', 'provider', 'openai']), /Usage: agent-cil config/);
  assert.throws(() => parseArgs(['config', 'set', 'model', '']), /Model preference/);
  assert.throws(() => parseArgs(['config', 'set', 'model', 'x'.repeat(257)]), /Model preference/);
});

test('real config commands persist, inspect and clear only the Anthropic model setting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-config-command-'));
  const configPath = join(directory, 'config.json');
  const env = {
    ...process.env,
    AGENT_CIL_CONFIG_PATH: configPath,
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: '',
  };
  try {
    await writeFile(configPath, JSON.stringify({ language: 'en', theme: 'dark' }));
    const set = spawnSync(process.execPath, [cli, 'config', 'set', 'model', 'opus'], {
      encoding: 'utf8', env,
    });
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /Saved default Anthropic model setting: opus/);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      language: 'en', theme: 'dark', model: 'opus',
    });

    const get = spawnSync(process.execPath, [cli, 'config', 'get', 'model'], {
      encoding: 'utf8', env,
    });
    assert.equal(get.status, 0, get.stderr);
    assert.equal(get.stdout, 'opus\n');

    const show = spawnSync(process.execPath, [cli, 'config', 'show'], {
      encoding: 'utf8', env,
    });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Saved Anthropic model setting: opus/);
    assert.match(show.stdout, /Interface language: English/);
    assert.doesNotMatch(show.stdout, /API_KEY|theme|dark/);

    const unset = spawnSync(process.execPath, [cli, 'config', 'unset', 'model'], {
      encoding: 'utf8', env,
    });
    assert.equal(unset.status, 0, unset.stderr);
    assert.match(unset.stdout, /Cleared saved Anthropic model setting/);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      language: 'en', theme: 'dark',
    });

    const missing = spawnSync(process.execPath, [cli, 'config', 'get', 'model'], {
      encoding: 'utf8', env,
    });
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.stdout, '(not set)\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('config accepts catalog-supported 1M settings and rejects unsupported model capabilities without replacing config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-config-invalid-'));
  const configPath = join(directory, 'config.json');
  const env = { ...process.env, AGENT_CIL_CONFIG_PATH: configPath, ANTHROPIC_API_KEY: '' };
  try {
    await writeFile(configPath, '{invalid json');
    const malformed = spawnSync(process.execPath, [cli, 'config', 'set', 'model', 'opus'], {
      encoding: 'utf8', env,
    });
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /Could not update|Unexpected token|JSON/);
    assert.equal(await readFile(configPath, 'utf8'), '{invalid json');

    await writeFile(configPath, JSON.stringify({ language: 'en' }));
    const supported = spawnSync(process.execPath, [cli, 'config', 'set', 'model', 'sonnet[1m]'], {
      encoding: 'utf8', env,
    });
    assert.equal(supported.status, 0, supported.stderr);
    assert.match(supported.stdout, /Saved default Anthropic model setting: sonnet\[1m\]/);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(saved, { language: 'en', model: 'sonnet[1m]' });

    const unsupported = spawnSync(process.execPath, [
      cli, 'config', 'set', 'model', 'claude-haiku-4-5[1m]',
    ], { encoding: 'utf8', env });
    assert.equal(unsupported.status, 2);
    assert.match(unsupported.stderr, /does not support the 1M context beta/);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), saved);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime model selection follows 2.1.88 priority: --model, env, saved settings, then default', {
  timeout: 30000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-model-priority-'));
  const configPath = join(directory, 'config.json');
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    res.end(finishStream('model configuration verified'));
  });
  let watchdog;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    async function runModel({
      savedModel, envModel, cliModel, defaultSonnet, availableModels, deniedModels,
    } = {}) {
      const config = { language: 'en' };
      if (savedModel !== undefined) config.model = savedModel;
      if (availableModels !== undefined) config.availableModels = availableModels;
      if (deniedModels !== undefined) config.deniedModels = deniedModels;
      await writeFile(configPath, JSON.stringify(config));
      const args = [
        cli, '--print', '--max-retries', '0', '--cwd', directory,
        '--base-url', 'http://127.0.0.1:' + address.port,
      ];
      if (cliModel !== undefined) args.push('--model', cliModel);
      args.push('Report the configured model.');
      const child = spawn(process.execPath, args, {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: 'model-config-test-key',
          AGENT_CIL_CONFIG_PATH: configPath,
          ANTHROPIC_MODEL: envModel ?? '',
          ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnet ?? '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      watchdog = setTimeout(() => child.kill('SIGKILL'), 8000);
      const [status, signal] = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, sig) => resolve([code, sig]));
      });
      clearTimeout(watchdog);
      watchdog = undefined;
      assert.equal(signal, null, stderr);
      assert.equal(status, 0, stderr);
      assert.equal(stdout.trim(), 'model configuration verified');
      return requests.at(-1).model;
    }

    assert.equal(await runModel({ savedModel: 'opus' }), 'claude-opus-5-5');
    assert.equal(await runModel({ savedModel: 'opus', envModel: 'haiku' }), 'claude-haiku-5-5');
    assert.equal(await runModel({ savedModel: 'opus', envModel: 'haiku', cliModel: 'sonnet' }), 'claude-sonnet-5-5');
    assert.equal(await runModel({}), 'claude-sonnet-5-5');
    assert.equal(await runModel({ defaultSonnet: 'custom-sonnet-default' }), 'custom-sonnet-default');
    assert.equal(await runModel({
      cliModel: 'opus', availableModels: ['sonnet'],
    }), 'claude-sonnet-5-5',
    'a disallowed explicit selection falls back to the permitted default');
    assert.equal(await runModel({
      cliModel: 'opus', deniedModels: ['opus'],
    }), 'claude-sonnet-5-5',
    'deniedModels blocks a family even when no allowlist is configured');
    assert.equal(await runModel({
      cliModel: 'opus', availableModels: ['opus', 'opus-5-5'],
    }), 'claude-opus-5-5',
    'a version-qualified allowlist narrows the family alias to that version');
    assert.equal(requests.length, 8);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    server.closeAllConnections?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});


test('empty model allowlist fails closed before a provider request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-model-policy-empty-'));
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      language: 'en',
      availableModels: [],
    }));
    const result = spawnSync(process.execPath, [
      cli, '--print', '--model', 'sonnet', '--max-retries', '0',
      '--cwd', directory, '--base-url', 'http://127.0.0.1:1',
      'Do not send a request when no model is allowed.',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'model-policy-test-key',
        AGENT_CIL_CONFIG_PATH: configPath,
        ANTHROPIC_MODEL: '',
      },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /No model remains available/);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      language: 'en', availableModels: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normal startup rejects an invalid saved model value instead of silently using the default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-model-config-invalid-value-start-'));
  const configPath = join(directory, 'config.json');
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: 'model-config-test-key',
    AGENT_CIL_CONFIG_PATH: configPath,
    ANTHROPIC_MODEL: '',
  };
  try {
    const original = JSON.stringify({ language: 'en', theme: 'dark', model: 123 });
    await writeFile(configPath, original);
    const result = spawnSync(process.execPath, [
      cli, '--print', '--max-retries', '0', '--cwd', directory,
      '--base-url', 'http://127.0.0.1:1', 'Do not make a model request.',
    ], { encoding: 'utf8', env });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /User configuration is invalid/);
    assert.equal(result.stdout, '');
    assert.equal(await readFile(configPath, 'utf8'), original);

    // The explicit config command can repair the field without losing other
    // user settings, so fail-closed does not strand the user.
    const repair = spawnSync(process.execPath, [cli, 'config', 'set', 'model', 'opus'], {
      encoding: 'utf8', env,
    });
    assert.equal(repair.status, 0, repair.stderr);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      language: 'en', theme: 'dark', model: 'opus',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normal startup refuses to silently discard an unreadable saved model setting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-model-config-corrupt-start-'));
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(configPath, '{invalid json');
    const result = spawnSync(process.execPath, [
      cli, '--print', '--cwd', directory, 'Do not make a model request.',
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'model-config-test-key',
        AGENT_CIL_CONFIG_PATH: configPath,
        ANTHROPIC_MODEL: '',
      },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /User configuration is invalid/);
    assert.equal(result.stdout, '');
    assert.equal(await readFile(configPath, 'utf8'), '{invalid json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
