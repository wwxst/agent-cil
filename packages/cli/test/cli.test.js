import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  CliArgumentError,
  createBuiltinTools,
  parseArgs,
  resolveWorkspacePath,
} from '../src/index.js';

test('version and help are handled before model credentials are needed', () => {
  assert.deepEqual(parseArgs(['--version']), { mode: 'version' });
  assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
});

test('executable version fast path exits without credentials', () => {
  const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
  const result = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'agent-cil 0.1.0\n');
  assert.equal(result.stderr, '');
});

test('parses model, endpoint, token, system, cwd, print and prompt options', () => {
  const options = parseArgs([
    '--print',
    '--model', 'claude-test-model',
    '--base-url=https://example.test',
    '--max-tokens', '2048',
    '--system', 'Be precise.',
    '--cwd', '/tmp/project',
    'explain', 'this repository',
  ]);
  assert.equal(options.print, true);
  assert.equal(options.model, 'claude-test-model');
  assert.equal(options.baseUrl, 'https://example.test');
  assert.equal(options.maxTokens, 2048);
  assert.equal(options.system, 'Be precise.');
  assert.equal(options.cwd, resolve('/tmp/project'));
  assert.equal(options.prompt, 'explain this repository');
});

test('rejects unknown options and invalid max token values', () => {
  assert.throws(() => parseArgs(['--unknown']), CliArgumentError);
  assert.throws(() => parseArgs(['--max-tokens', '0']), CliArgumentError);
  assert.throws(() => parseArgs(['--model']), CliArgumentError);
});

test('workspace path resolution rejects traversal outside the workspace', () => {
  const root = resolve('/tmp/agent-cil-workspace');
  assert.equal(resolveWorkspacePath(root, 'src/index.js'), join(root, 'src', 'index.js'));
  assert.throws(() => resolveWorkspacePath(root, '../outside.txt'), /escapes the workspace/);
});

test('built-in tools provide read, write and unique-match edit operations', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-cli-'));
  try {
    const tools = await createBuiltinTools({ workspace });
    assert.deepEqual(tools.list().map((tool) => tool.name), ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);

    await tools.get('Write').execute({ file_path: 'src/example.js', content: 'const value = 1;\n' });
    assert.equal(await tools.get('Read').execute({ file_path: 'src/example.js' }), 'const value = 1;\n');

    await tools.get('Edit').execute({
      file_path: 'src/example.js',
      old_string: 'value = 1',
      new_string: 'value = 2',
    });
    assert.equal(await readFile(join(workspace, 'src/example.js'), 'utf8'), 'const value = 2;\n');

    await assert.rejects(
      tools.get('Edit').execute({
        file_path: 'src/example.js',
        old_string: 'value = 1',
        new_string: 'let',
      }),
      /old_string was not found|occurs more than once/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('file tools reject symbolic links that resolve outside the workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-safe-workspace-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-cil-outside-'));
  try {
    const outsideFile = join(outside, 'secret.txt');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, join(workspace, 'linked.txt'));
    await symlink(join(outside, 'missing.txt'), join(workspace, 'broken-link.txt'));
    const tools = await createBuiltinTools({ workspace });
    await assert.rejects(tools.get('Read').execute({ file_path: 'linked.txt' }), /Symbolic links are not allowed/);
    await assert.rejects(tools.get('Write').execute({ file_path: 'linked.txt', content: 'overwrite' }), /Symbolic links are not allowed/);
    await assert.rejects(tools.get('Write').execute({ file_path: 'broken-link.txt', content: 'create outside' }), /Symbolic links are not allowed/);
    assert.equal(await readFile(outsideFile, 'utf8'), 'secret');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
test('Glob and Grep search within the workspace and return relative paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-cil-search-'));
  try {
    await writeFile(join(workspace, 'alpha.js'), 'export const needle = true;\n');
    await writeFile(join(workspace, 'beta.txt'), 'nothing here\n');
    const tools = await createBuiltinTools({ workspace });
    const glob = await tools.get('Glob').execute({ pattern: '*.js' });
    assert.deepEqual(glob.matches, ['alpha.js']);

    const grep = await tools.get('Grep').execute({ pattern: 'needle' });
    assert.equal(grep.matches.length, 1);
    assert.equal(grep.matches[0].path, 'alpha.js');
    assert.equal(grep.matches[0].line, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
