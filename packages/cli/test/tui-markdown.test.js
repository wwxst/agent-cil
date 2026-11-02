import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
const { register } = await import('tsx/esm/api');
register();
const { register: registerNodeLoader } = await import('node:module');
registerNodeLoader(new URL('../src/tui/node-loader.js', import.meta.url), import.meta.url);

const [{ applyMarkdown }, component] = await Promise.all([
  import('../../../legacy/2.1.88/restored-src/src/utils/markdown.ts'),
  import('../src/tui/MessageContent.tsx'),
]);

test('original 2.1.88 Markdown formatter renders common assistant content', () => {
  const output = applyMarkdown([
    '# Build result',
    '',
    '**completed** with `node`.',
    '',
    '- Read source',
    '- Write patch',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '| tool | status |',
    '| --- | --- |',
    '| Read | ok |',
  ].join('\n'), 'dark');

  assert.match(output, /Build result/);
  assert.match(output, /completed/);
  assert.match(output, /Read source/);
  assert.match(output, /Write patch/);
  assert.match(output, /const answer = 42/);
  assert.match(output, /tool/);
  assert.match(output, /status/);
  assert.doesNotMatch(output, /\*\*completed\*\*/);
  assert.doesNotMatch(output, /```/);
});

test('original Markdown strips internal prompt-only XML tags before rendering', () => {
  const output = applyMarkdown('Visible <context>private prompt context</context> answer.', 'dark');
  assert.match(output, /Visible/);
  assert.match(output, /answer/);
  assert.doesNotMatch(output, /private prompt context/);
});

test('the transcript Markdown component is available through the Node TSX boundary', () => {
  assert.equal(typeof component.default, 'function');
});
