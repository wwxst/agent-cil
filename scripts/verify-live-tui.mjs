#!/usr/bin/env node
/**
 * Credentialed live acceptance for the interactive Ink TUI.
 *
 * This is deliberately manual: no provider credentials are read by CI or
 * embedded in the repository. Install node-pty locally, set one provider's
 * environment variables, then run this script against a real model.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import stripAnsi from 'strip-ansi';

const provider = process.env.AGENT_CIL_PROVIDER || 'anthropic';
const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY
  : provider === 'deepseek'
    ? (process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
const baseUrl = provider === 'openai'
  ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
  : provider === 'deepseek'
    ? (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic')
    : process.env.ANTHROPIC_BASE_URL;
const model = provider === 'openai'
  ? (process.env.OPENAI_MODEL || 'gpt-5.1')
  : provider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL || 'deepseek-flash')
    : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5');
const invokedDirectly = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const executable = (invokedDirectly ? process.argv[2] : null) ||
  process.env.AGENT_CIL_TEST_EXECUTABLE ||
  fileURLToPath(new URL('../packages/cli/src/index.js', import.meta.url));

function redact(value) {
  return String(value ?? '').replaceAll(apiKey || '\u0000NO_SECRET\u0000', '[REDACTED]');
}
function normalizeOutput(value) {
  return stripAnsi(String(value ?? '').replace(
    /\x1b\[(\d*)C/g,
    (_sequence, count) => ' '.repeat(Number(count || 1)),
  ));
}
function validateConfiguration() {
  if (!['anthropic', 'deepseek', 'openai'].includes(provider)) {
    throw new Error('AGENT_CIL_PROVIDER must be anthropic, deepseek, or openai.');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('The selected provider API key must be set in the local environment.');
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('Set the selected provider base URL explicitly.');
  }
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL must not contain credentials, query, or fragment.');
  }
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS provider URL or a loopback URL for a local test provider.');
  }
}

export async function main({ turnTimeoutMs = 120_000 } = {}) {
  validateConfiguration();
  let pty;
  try {
    pty = await import('node-pty');
  } catch {
    throw new Error('node-pty is required for a real interactive TTY. Install it locally with: npm install --no-save node-pty@1.1.0');
  }
  const spawnPty = pty.spawn ?? pty.default?.spawn;
  assert.equal(typeof spawnPty, 'function', 'node-pty does not expose spawn().');

  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-live-tui-'));
  const configDirectory = join(workspace, '.agent-cil-live-config');
  const source = join(workspace, 'math.js');
  const original = 'export function add(a, b) {\n  return a - b;\n}\n';
  const expected = 'export function add(a, b) {\n  return a + b;\n}\n';
  await writeFile(source, original);

  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.DEEPSEEK_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  if (provider === 'anthropic') childEnv.ANTHROPIC_API_KEY = apiKey;
  else if (provider === 'deepseek') childEnv.DEEPSEEK_API_KEY = apiKey;
  else childEnv.OPENAI_API_KEY = apiKey;
  childEnv.AGENT_CIL_CONFIG_DIR = configDirectory;
  childEnv.TERM = 'xterm-256color';
  childEnv.COLUMNS = '120';
  childEnv.LINES = '40';

  const isNodeScript = /\.(?:c|m)?js$/i.test(executable);
  const command = isNodeScript ? process.execPath : executable;
  const cliArgs = [
    ...(isNodeScript ? [resolve(executable)] : []),
    '--language', 'en',
    '--provider', provider,
    '--model', model,
    '--base-url', baseUrl,
    '--cwd', workspace,
    '--max-retries', '1',
    '--max-turns', '8',
    '--max-tokens', '1024',
    '--allow-edits',
    'In math.js, add(a,b) currently subtracts. MUST use Read to inspect the file, Edit to replace "return a - b;" with "return a + b;", and Read again to verify the exact final content. Do not use Bash, Write, or tools outside this workspace. After verification, reply exactly LIVE_TUI_FIXED.',
  ];

  let terminal;
  let exitInfo = null;
  let output = '';
  let overflow = false;
  let resolveExit;
  const exitPromise = new Promise(resolvePromise => { resolveExit = resolvePromise; });
  const timeoutError = label => new Error(label + '. Last TUI output:\n' + redact(normalizeOutput(output).slice(-2500)));
  const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
  const waitFor = async (predicate, label, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (overflow) throw timeoutError('TUI output exceeded 512 KiB');
      if (exitInfo) throw timeoutError(label + ': CLI exited early (' + exitInfo.exitCode + '/' + exitInfo.signal + ')');
      await sleep(50);
    }
    throw timeoutError(label + ': timed out after ' + timeoutMs + ' ms');
  };
  const completedMarker = (segment, marker) => {
    const normalized = normalizeOutput(segment);
    const first = normalized.indexOf(marker);
    const last = normalized.lastIndexOf(marker);
    // Each marker is deliberately present once in the user prompt. Require a
    // second occurrence in assistant output, followed by Ready, so the input
    // echo cannot be mistaken for a completed model response.
    return first >= 0 && last > first &&
      normalized.slice(last + marker.length).includes('Ready');
  };

  try {
    terminal = spawnPty(command, cliArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workspace,
      useConpty: process.platform === 'win32',
      env: childEnv,
    });
    terminal.onData(data => {
      output += data;
      if (output.length > 512 * 1024) {
        overflow = true;
        try { terminal.kill(); } catch {}
      }
    });
    terminal.onExit(info => {
      exitInfo = info;
      resolveExit(info);
    });

    await waitFor(
      () => completedMarker(output, 'LIVE_TUI_FIXED'),
      'first interactive coding turn did not complete',
      turnTimeoutMs,
    );
    const afterEdit = await readFile(source, 'utf8');
    assert.equal(afterEdit, expected,
      'the live TUI model did not complete the required Read -> Edit -> Read task');
    // Ink's incremental renderer can split spaces into cursor-forward
    // sequences. Normalize visual whitespace before counting tool rows.
    const firstTurnTranscript = normalizeOutput(output).replace(/\s+/g, ' ');
    const firstTurnReads = firstTurnTranscript.match(/Read\s*·\s*completed/g) || [];
    assert.ok(firstTurnReads.length >= 2,
      'the first live TUI turn must complete two Read tool calls; found ' +
      firstTurnReads.length + '. Recent transcript: ' +
      redact(firstTurnTranscript.slice(-5000)));
    assert.match(firstTurnTranscript, /Edit\s*·\s*completed/,
      'the first live TUI turn must complete an Edit tool call');
    assert.doesNotMatch(firstTurnTranscript, /Bash\s*·/,
      'the first live TUI turn must not invoke Bash');
    process.stdout.write('PASS: real Ink TUI completed Read -> Edit -> Read and verified workspace content.\n');

    const secondPromptStart = output.length;
    terminal.write('Read math.js again, calculate add(2,3), and reply exactly LIVE_TUI_SECOND_TURN:5. Do not edit the file.');
    await sleep(250);
    let submitted = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      terminal.write('\r');
      await sleep(250);
      const secondOutput = normalizeOutput(output.slice(secondPromptStart));
      if (secondOutput.includes('Working')) {
        submitted = true;
        break;
      }
      if (exitInfo) break;
    }
    assert.ok(submitted, timeoutError('second interactive prompt was not accepted').message);
    await waitFor(
      () => completedMarker(output.slice(secondPromptStart), 'LIVE_TUI_SECOND_TURN:5'),
      'second interactive model turn did not complete',
      turnTimeoutMs,
    );

    const normalized = normalizeOutput(output);
    assert.doesNotMatch(normalized, /Bash ·/,
      'the live TUI acceptance must not execute or request Bash');
    assert.doesNotMatch(output,
      /Could not start the original Ink TUI|falling back to the readline interface/);
    terminal.write('/exit\r');
    const exit = await Promise.race([
      exitPromise,
      sleep(10_000).then(() => {
        try { terminal.kill(); } catch {}
        throw timeoutError('TUI did not exit after /exit');
      }),
    ]);
    assert.equal(exit.exitCode, 0, redact(normalizeOutput(output).slice(-2500)));
    assert.equal(exit.signal ?? null, null);
    const config = JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8'));
    assert.equal(config.language, 'en');
    process.stdout.write('PASS: second interactive turn completed without losing TUI input state.\n');
    process.stdout.write('Provider: ' + provider + '\n');
    process.stdout.write('Model: ' + model + '\n');
    process.stdout.write('Base URL: ' + new URL(baseUrl).origin + ' (path omitted)\n');
    process.stdout.write('Credentialed live TUI acceptance completed; credentials were not printed.\n');
  } finally {
    if (terminal) {
      if (!exitInfo) {
        try { terminal.kill(); } catch {}
        await Promise.race([exitPromise, sleep(5000)]);
      }
      // node-pty needs an explicit final kill to release the native PTY handle
      // even after onExit has fired (especially on Windows ConPTY).
      try { terminal.kill(); } catch {}
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write('FAIL: ' + redact(error instanceof Error ? error.message : error) + '\n');
    process.exitCode = 1;
  });
}
