import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const packagesRoot = join(repositoryRoot, 'packages');
const testFiles = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await collect(path);
    } else if (entry.isFile() && entry.name.endsWith('.test.js') &&
      path.split(sep).includes('test')) {
      testFiles.push(relative(repositoryRoot, path));
    }
  }
}

await collect(packagesRoot);
testFiles.sort();
if (testFiles.length === 0) {
  process.stderr.write('No package test files were discovered.\n');
  process.exitCode = 1;
} else {
  process.stdout.write('Running ' + testFiles.length + ' package test files.\n');
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? (result.signal ? 1 : 1);
}
