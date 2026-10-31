import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// The original source stays byte-identical. Node adapters only replace the
// incompatible ThemeProvider/Bun barrel imports and map semantic theme colors;
// their mature SelectOption/ListItem render bodies are not reimplemented.
const root = new URL('../../../legacy/2.1.88/restored-src/src/', import.meta.url);
const beforeSourceMap = source => source.split('//# sourceMappingURL=')[0];

for (const [original, adapter, functionName] of [
  [
    'components/CustomSelect/select-option.tsx',
    'components/CustomSelect/select-option.node.tsx',
    'SelectOption',
  ],
  [
    'components/design-system/ListItem.tsx',
    'components/design-system/ListItem.node.tsx',
    'ListItem',
  ],
]) {
  test('original 2.1.88 ' + functionName + ' render body remains intact in Node adapter', async () => {
    const source = beforeSourceMap(await readFile(new URL(original, root), 'utf8'));
    const node = beforeSourceMap(await readFile(new URL(adapter, root), 'utf8'));
    const marker = 'export function ' + functionName + '(';
    assert.ok(source.includes(marker) && node.includes(marker));
    assert.equal(node.slice(node.indexOf(marker)).trim(), source.slice(source.indexOf(marker)).trim());
  });
}
