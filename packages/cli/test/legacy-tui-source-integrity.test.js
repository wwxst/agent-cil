import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const manifestPath = resolve(repositoryRoot, 'legacy/2.1.88/TUI-SOURCE-MANIFEST.json');

test('2.1.88 TUI source and compatibility boundary match their pinned Git blob manifest', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceCommit, '57d4d4d05121f84601af119091455832d37de5df');
  assert.equal(manifest.sourceVersion, '2.1.88');
  assert.equal(manifest.importedFileCount, 142);
  assert.equal(manifest.files.length, manifest.importedFileCount);
  assert.equal(manifest.compatibilityFiles.length, 19);

  let inkFiles = 0;
  for (const entry of [...manifest.files, ...manifest.compatibilityFiles]) {
    const content = await readFile(resolve(repositoryRoot, entry.path));
    const header = Buffer.from('blob ' + Buffer.byteLength(content, 'utf8') + '\0');
    const actual = createHash('sha1').update(header).update(content).digest('hex');
    assert.equal(actual, entry.gitBlobSha, entry.path);
    if (entry.path.includes('/src/ink/')) inkFiles += 1;
  }
  assert.equal(inkFiles, 98);
});
