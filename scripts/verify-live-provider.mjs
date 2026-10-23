#!/usr/bin/env node
/**
 * Credentialed live-provider acceptance for agent-cil.
 *
 * No API key or provider URL is embedded in this file or sent to GitHub CI.
 * Run manually with provider-specific API key and model in the local
 * environment and an installed CLI binary in PATH (or argv[2]).
 *
 * This is intentionally NOT part of CI, where no live provider credential
 * or third-party model entitlement is configured.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = process.env.AGENT_CIL_PROVIDER || 'anthropic';
const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY
  : provider === 'deepseek'
    ? (process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
const baseUrl = provider === 'openai'
  ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1')
  : provider === 'deepseek'
    ? (process.env.DEEPSEEK_BASE_URL || process.env.ANTHROPIC_BASE_URL ||
       'https://api.deepseek.com/anthropic')
    : process.env.ANTHROPIC_BASE_URL;
const model = provider === 'openai'
  ? (process.env.OPENAI_MODEL || 'gpt-5.1')
  : provider === 'deepseek'
    ? (process.env.DEEPSEEK_MODEL || process.env.ANTHROPIC_MODEL || 'deepseek-flash')
    : (process.env.ANTHROPIC_MODEL || 'deepseek-flash');
const executable = process.argv[2] || process.env.AGENT_CIL_TEST_EXECUTABLE || 'agent-cil';

function redact(text) {
  return String(text).replaceAll(apiKey || '\u0000NO_SECRET\u0000', '[REDACTED]');
}
function validateConfiguration() {
  if (!['anthropic', 'deepseek', 'openai'].includes(provider)) {
    throw new Error('AGENT_CIL_PROVIDER must be anthropic, deepseek, or openai.');
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('Provider API key must be set through the local environment.');
  }
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error('ANTHROPIC_BASE_URL must be set explicitly for this model provider.');
  }
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('ANTHROPIC_BASE_URL must not contain credentials, query, or fragment.');
  }
  if (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS base URL or a loopback URL for a local test provider.');
  }
}
async function runCli({ workspace, prompt, label }) {
  const args = [
    '--print', '--allow-edits', '--max-retries', '1', '--max-turns', '8',
    '--max-tokens', '1024', '--provider', provider, '--model', model,
    '--base-url', baseUrl, '--cwd', workspace, prompt,
  ];
  const child = spawn(executable, args, {
    env: { ...process.env, ANTHROPIC_API_KEY: provider === 'anthropic' ? apiKey : undefined,
      DEEPSEEK_API_KEY: provider === 'deepseek' ? apiKey : undefined,
      OPENAI_API_KEY: provider === 'openai' ? apiKey : undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const limit = 256 * 1024;
  const accumulate = key => chunk => {
    const next = chunk.toString('utf8');
    if (key === 'stdout') {
      if (stdout.length + next.length <= limit) stdout += next;
      else overflow = true;
    } else {
      if (stderr.length + next.length <= limit) stderr += next;
      else overflow = true;
    }
    if (overflow) child.kill('SIGKILL');
  };
  child.stdout.on('data', accumulate('stdout'));
  child.stderr.on('data', accumulate('stderr'));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 120_000);
  try {
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    if (overflow) throw new Error(label + ': output exceeded 256 KiB.');
    if (timedOut) throw new Error(label + ': timed out after 120 seconds.');
    if (signal || status !== 0) {
      throw new Error(label + ': CLI exited abnormally (' +
        String(status) + '/' + String(signal) + '). ' +
        redact(stderr).slice(0, 2000));
    }
    if (!stdout.trim()) throw new Error(label + ': streamed response was empty.');
    return { stdout: redact(stdout), stderr: redact(stderr) };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  validateConfiguration();
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-live-model-'));
  try {
    const source = join(workspace, 'math.js');
    const original = 'export function add(a, b) {\n  return a - b;\n}\n';
    const expected = 'export function add(a, b) {\n  return a + b;\n}\n';
    await writeFile(source, original);

    const ping = await runCli({
      workspace,
      label: 'streaming',
      prompt: 'Reply with the exact word READY. Do not invoke any tools.',
    });
    assert.ok(ping.stdout.trim(), 'provider streaming returned no text.');
    process.stdout.write('PASS: credentialed streaming response from selected model.\n');

    const coding = await runCli({
      workspace,
      label: 'read-edit-read',
      prompt: 'You are testing a coding CLI. In math.js, add(a,b) currently subtracts. ' +
        'MUST use Read to inspect math.js, Edit to replace "return a - b;" with ' +
        '"return a + b;", and Read again to verify. Do not use Bash, Write, ' +
        'or any tool outside this workspace. Then answer "fixed".',
    });
    const after = await readFile(source, 'utf8');
    assert.equal(after, expected, 'the live model did not perform the expected edit.');
    const readCount = (coding.stderr.match(/\[tool\] Read\b/g) || []).length;
    assert.ok(readCount >= 2, 'expected at least two Read tool calls.');
    assert.match(coding.stderr, /\[tool\] Edit\b/, 'expected an Edit tool call.');
    process.stdout.write('PASS: live Read -> Edit -> Read coding task, workspace content verified.\n');
    process.stdout.write('Provider: ' + provider + '\n');
    process.stdout.write('Model: ' + model + '\n');
    process.stdout.write('Base URL: ' + new URL(baseUrl).origin + ' (path omitted)\n');
    process.stdout.write('Credentialed provider acceptance completed without exporting secrets.\n');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write('FAIL: ' + redact(error instanceof Error ? error.message : error) + '\n');
  process.exitCode = 1;
});
