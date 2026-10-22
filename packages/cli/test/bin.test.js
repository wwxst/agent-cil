import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const binPath = fileURLToPath(new URL('../src/bin.js', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function runBin(args) {
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 5_000,
  });
}

test('actual executable prints help and version without model credentials', () => {
  const help = runBin(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, '');

  const version = runBin(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, 'agent-cil 0.1.0\n');
  assert.equal(version.stderr, '');
});

test('actual executable rejects the unimplemented SDK stream-json flags explicitly', () => {
  const result = runBin(['--input-format', 'stream-json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option: --input-format/);
  assert.equal(result.stdout, '');
});
