import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseArgs } from '../src/index.js';
import {
  detectSystemLanguage, getHelp, getLanguageConfigPath, languageLabel,
  loadLanguagePreference, localizeCliMessage, normalizeLanguagePreference,
  resolveLanguage, saveLanguagePreference, translate,
} from '../src/i18n.js';

test('system language detection honors locale environment precedence', () => {
  assert.equal(detectSystemLanguage({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }), 'zh-CN');
  assert.equal(detectSystemLanguage({ LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'zh_CN.UTF-8' }), 'en');
  assert.equal(detectSystemLanguage({ LC_ALL: 'C.UTF-8', LANG: 'zh_CN.UTF-8' }), 'zh-CN');
  assert.equal(detectSystemLanguage({ LANGUAGE: 'zh_CN:en_US' }), 'zh-CN');
  assert.equal(detectSystemLanguage({}, 'zh-Hans-CN'), 'zh-CN');
  assert.equal(detectSystemLanguage({}, 'fr-FR'), 'en');
});

test('only auto, Simplified Chinese and English are accepted preferences', () => {
  assert.equal(normalizeLanguagePreference('auto'), 'auto');
  assert.equal(normalizeLanguagePreference('zh-CN'), 'zh-CN');
  assert.equal(normalizeLanguagePreference('zh_cn'), 'zh-CN');
  assert.equal(normalizeLanguagePreference('zh'), 'zh-CN');
  assert.equal(normalizeLanguagePreference('en-US'), 'en');
  assert.equal(normalizeLanguagePreference('en-gb'), 'en');
  assert.equal(normalizeLanguagePreference('zh-TW'), null);
  assert.equal(normalizeLanguagePreference('ja-JP'), null);
  assert.equal(resolveLanguage('auto', { LANG: 'zh_CN.UTF-8' }), 'zh-CN');
  assert.equal(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' }), 'en');
});

test('config path follows explicit override, Windows APPDATA and XDG precedence', () => {
  assert.equal(getLanguageConfigPath({ AGENT_CIL_CONFIG_PATH: '/tmp/custom/config.json' }, '/home/test'), resolve('/tmp/custom/config.json'));
  assert.equal(getLanguageConfigPath({ AGENT_CIL_CONFIG_DIR: '/tmp/agent-cil-config' }, '/home/test'), join(resolve('/tmp/agent-cil-config'), 'config.json'));
  assert.equal(getLanguageConfigPath({ APPDATA: '/tmp/roaming' }, '/home/test'), join('/tmp/roaming', 'agent-cil', 'config.json'));
  assert.equal(getLanguageConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/test'), join('/tmp/xdg', 'agent-cil', 'config.json'));
});

test('first run detects the system locale without creating a configuration file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-locale-first-run-'));
  try {
    const state = await loadLanguagePreference({ env: { AGENT_CIL_CONFIG_DIR: directory, LANG: 'zh_CN.UTF-8' } });
    assert.equal(state.preference, 'auto');
    assert.equal(state.locale, 'zh-CN');
    assert.equal(state.configError, undefined);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('language preference persists atomically and preserves unrelated user settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-locale-persist-'));
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({ theme: 'dark', model: 'test-model' }));
    const saved = await saveLanguagePreference('zh-CN', { env: { AGENT_CIL_CONFIG_PATH: configPath, LANG: 'en_US.UTF-8' } });
    assert.equal(saved.preference, 'zh-CN');
    assert.equal(saved.locale, 'zh-CN');
    const state = await loadLanguagePreference({ env: { AGENT_CIL_CONFIG_PATH: configPath, LANG: 'en_US.UTF-8' } });
    assert.equal(state.preference, 'zh-CN');
    assert.equal(state.locale, 'zh-CN');
    assert.deepEqual(state.config, { theme: 'dark', model: 'test-model', language: 'zh-CN' });
    assert.deepEqual(await readdir(directory), ['config.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed configuration is not overwritten by language preference updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-locale-invalid-'));
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(configPath, '{invalid json');
    const state = await loadLanguagePreference({ env: { AGENT_CIL_CONFIG_PATH: configPath, LANG: 'zh_CN.UTF-8' } });
    assert.equal(state.locale, 'zh-CN');
    assert.ok(state.configError instanceof SyntaxError);
    await assert.rejects(saveLanguagePreference('en', { env: { AGENT_CIL_CONFIG_PATH: configPath } }), SyntaxError);
    assert.equal(await readFile(configPath, 'utf8'), '{invalid json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('translation interpolates values and uses English fallback for unknown keys', () => {
  assert.equal(translate('zh-CN', 'languageSet', { language: '简体中文' }), '界面语言已切换为 简体中文。');
  assert.equal(translate('en', 'toolFailed', { tool: 'Bash', status: 'failed' }), '[tool] Bash failed');
  assert.equal(translate('zh-CN', 'missing.translation.key'), 'missing.translation.key');
  assert.equal(languageLabel('zh-CN', 'zh-CN'), '简体中文');
  assert.equal(languageLabel('en', 'en'), 'English');
});

test('help output is complete in both supported interface languages', () => {
  const english = getHelp('en', '9.9.9');
  const chinese = getHelp('zh-CN', '9.9.9');
  assert.match(english, /agent-cil 9\.9\.9/);
  assert.match(chinese, /agent-cil 9\.9\.9/);
  assert.match(english, /--language <auto\|zh-CN\|en>/);
  assert.match(chinese, /--language <auto\|zh-CN\|en>/);
  assert.match(chinese, /环境变量：/);
  assert.match(chinese, /内置工具：/);
  assert.doesNotMatch(chinese, /helpUsage|helpOptions|helpEnvironment|helpTools|helpDescription/);
});

test('known CLI errors are translated while technical details remain intact', () => {
  assert.equal(localizeCliMessage('Unknown option: --bad', 'zh-CN'), '未知选项：--bad');
  assert.equal(localizeCliMessage('Workspace directory is unavailable: C:\\work (Access denied)', 'zh-CN'), '工作区目录不可用：C:\\work（Access denied）');
  assert.equal(localizeCliMessage('provider returned an unknown error', 'zh-CN'), 'provider returned an unknown error');
});

test('CLI parses explicit language preferences without changing the Agent prompt', () => {
  const options = parseArgs(['--language', 'zh-CN', 'explain', 'this repository']);
  assert.equal(options.language, 'zh-CN');
  assert.equal(options.prompt, 'explain this repository');
  assert.equal(parseArgs(['--language=en']).language, 'en');
  assert.equal(parseArgs(['--language=auto']).language, 'auto');
  assert.throws(() => parseArgs(['--language', 'ja-JP']), /Language must be auto, zh-CN, or en/);
});

test('real CLI help auto-detects Chinese and explicit language selection persists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-locale-cli-'));
  const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  try {
    const help = spawnSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_CIL_CONFIG_DIR: directory, LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /用法：/);
    assert.match(help.stdout, /环境变量：/);
    assert.doesNotMatch(help.stdout, /Usage:/);

    const setLanguage = spawnSync(process.execPath, [cliPath, '--language', 'zh-CN'], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_CIL_CONFIG_DIR: directory, LC_ALL: 'C', LANG: 'en_US.UTF-8', ANTHROPIC_API_KEY: '' },
    });
    assert.equal(setLanguage.status, 2);
    assert.match(setLanguage.stderr, /缺少 ANTHROPIC_API_KEY/);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    assert.equal(config.language, 'zh-CN');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interactive TTY language command switches the live prompt and persists the selected language', {
  skip: process.platform !== 'linux' || spawnSync('script', ['--version'], { stdio: 'ignore' }).status !== 0,
  timeout: 15000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-cil-locale-tty-'));
  const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const command = [
    process.execPath, cliPath, '--base-url', 'http://127.0.0.1:1',
    '--model', 'locale-tty-fixture', '--cwd', directory,
  ].map(quote).join(' ');
  let child;
  let timeout;
  try {
    child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'locale-tty-key',
        AGENT_CIL_CONFIG_DIR: directory,
        LC_ALL: 'en_US.UTF-8',
        LANG: 'en_US.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderr = '';
    let stage = 0;
    let exited = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (stage === 0 && output.includes('you> ')) {
        stage = 1;
        child.stdin.write('/language zh-CN\\n');
      }
      if (stage === 1 && output.includes('界面语言已切换为 简体中文。') && output.includes('你> ')) {
        stage = 2;
        child.stdin.write('/language\\n');
      }
      if (stage === 2 && output.includes('当前界面语言：简体中文')) {
        stage = 3;
        child.stdin.write('/language en\\n');
      }
      if (stage === 3 && output.includes('Interface language set to English.')) {
        stage = 4;
        child.stdin.write('/exit\\n');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    timeout = setTimeout(() => child.kill('SIGKILL'), 9000);
    const [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve([code, sig]));
    });
    exited = true;
    assert.equal(signal, null, 'interactive language test timed out: ' + output + '\\n' + stderr);
    assert.equal(status, 0, output + '\\n' + stderr);
    assert.equal(stage, 4, 'not all live language transitions were observed: ' + output);
    assert.match(output, /当前界面语言：简体中文/);
    assert.match(output, /界面语言已切换为 简体中文。/);
    assert.match(output, /Interface language set to English\./);
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    assert.equal(config.language, 'en');
  } finally {
    if (!exited && child && child.exitCode === null) child.kill('SIGKILL');
    if (timeout) clearTimeout(timeout);
    await rm(directory, { recursive: true, force: true });
  }
});
