import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { JsonlParser, FrameTooLargeError, encodeJsonlFrame } from '../src/jsonl.js';

async function decodeChunks(chunks, options) {
  const parser = new JsonlParser(options);
  const frames = [];
  const frameErrors = [];
  parser.on('data', frame => frames.push(frame));
  parser.on('frameError', error => frameErrors.push(error));
  const ended = once(parser, 'end');
  for (const chunk of chunks) parser.write(chunk);
  parser.end();
  await ended;
  return { frames, frameErrors };
}

test('encodes one JSON object per line and rejects non-object frames', () => {
  assert.equal(encodeJsonlFrame({ type: 'user', text: 'line one\nline two' }), '{"type":"user","text":"line one\\nline two"}\n');
  assert.throws(() => encodeJsonlFrame(null), /non-null JSON object/);
  assert.throws(() => encodeJsonlFrame(['not', 'an object']), /non-null JSON object/);
});

test('decodes fragmented UTF-8 frames, CRLF and a final frame without newline', async () => {
  const bytes = Buffer.from('{"type":"user","text":"你好 🌏"}\r\n{"type":"result","ok":true}', 'utf8');
  const result = await decodeChunks([bytes.subarray(0, 13), bytes.subarray(13, 19), bytes.subarray(19)]);
  assert.deepEqual(result.frames, [
    { type: 'user', text: '你好 🌏' },
    { type: 'result', ok: true },
  ]);
  assert.equal(result.frameErrors.length, 0);
});

test('skips blank lines and recovers after malformed/non-object frames', async () => {
  const result = await decodeChunks([
    Buffer.from('\n{"type":"user"}\n{broken}\n[]\n{"type":"result"}\n'),
  ]);
  assert.deepEqual(result.frames, [{ type: 'user' }, { type: 'result' }]);
  assert.equal(result.frameErrors.length, 2);
  assert.match(result.frameErrors[0].message, /line 3/);
  assert.match(result.frameErrors[1].message, /line 4/);
});

test('rejects an oversized frame rather than buffering without bound', async () => {
  const parser = new JsonlParser({ maxFrameBytes: 8 });
  const failed = once(parser, 'error');
  parser.write(Buffer.from('123456789'));
  parser.end();
  const [error] = await failed;
  assert.ok(error instanceof FrameTooLargeError);
  assert.equal(error.maxFrameBytes, 8);
});

test('accepts a UTF-8 BOM only at the beginning of the stream', async () => {
  const result = await decodeChunks([Buffer.from('\uFEFF{"type":"system"}\n')]);
  assert.deepEqual(result.frames, [{ type: 'system' }]);
  assert.equal(result.frameErrors.length, 0);
});

test('reports invalid UTF-8 as a recoverable frame error', async () => {
  const result = await decodeChunks([Buffer.concat([
    Buffer.from('{"type":"bad","text":"'), Buffer.from([0xc3, 0x28]),
    Buffer.from('"}\n{"type":"good"}\n'),
  ])]);
  assert.deepEqual(result.frames, [{ type: 'good' }]);
  assert.equal(result.frameErrors.length, 1);
});
