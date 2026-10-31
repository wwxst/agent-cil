import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
const { register } = await import('tsx/esm/api');
register();
const { Cursor } = await import('../../../legacy/2.1.88/restored-src/src/utils/Cursor.ts');

test('original 2.1.88 Cursor moves and deletes by grapheme, not UTF-16 code unit', () => {
  const value = 'A中🙂B';
  const start = Cursor.fromText(value, 80, 1);
  const afterCjk = start.right();
  const afterEmoji = afterCjk.right();
  const afterLast = afterEmoji.right();

  assert.equal(afterCjk.offset, 2);
  assert.equal(afterEmoji.offset, 4);
  assert.equal(afterLast.offset, 5);
  assert.equal(Cursor.fromText(value, 80, 4).backspace().text, 'A中B');
});

test('original 2.1.88 Cursor measures mixed CJK and emoji in terminal cells', () => {
  const value = 'A中🙂B';
  assert.equal(Cursor.fromText(value, 80, 2).getPosition().column, 3);
  assert.equal(Cursor.fromText(value, 80, 4).getPosition().column, 5);
});

test('original Cursor viewport keeps the active caret visible in wrapped mixed-width input', () => {
  const value = '中文 mixed text 🙂 and more words to wrap';
  const cursor = Cursor.fromText(value, 8, value.length);
  assert.ok(cursor.getViewportStartLine(3) >= 0);
  assert.ok(cursor.getViewportStartLine(3) < cursor.getPosition().line + 1);
  assert.ok(cursor.getViewportCharEnd(3) <= value.length);
});
