import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCliArgs, CLI_VERSION, DEFAULT_MODEL } from '../src/args.js';

test('help and version are fast paths', () => {
  assert.deepEqual(parseCliArgs(['--help']), { action: 'help' });
  assert.deepEqual(parseCliArgs(['-V']), { action: 'version' });
  assert.equal(CLI_VERSION, '0.1.0');
  assert.equal(DEFAULT_MODEL, 'claude-sonnet-4-6');
});

test('parses print options in separate and equals forms', () => {
  assert.deepEqual(parseCliArgs([
    '--print', '--model', 'model-a', '--max-turns', '3',
    '--system-prompt', 'be precise', '--output-format', 'json', '--verbose',
    'summarize', 'these files',
  ]), {
    action: 'run',
    print: true,
    model: 'model-a',
    maxTurns: 3,
    systemPrompt: 'be precise',
    outputFormat: 'json',
    verbose: true,
    prompt: 'summarize these files',
  });

  const equals = parseCliArgs([
    '-p', '--model=model-b', '--max-turns=4',
    '--system-prompt=brief', '--output-format=text', '--', '-literal prompt',
  ]);
  assert.equal(equals.model, 'model-b');
  assert.equal(equals.maxTurns, 4);
  assert.equal(equals.systemPrompt, 'brief');
  assert.equal(equals.prompt, '-literal prompt');
});

test('rejects unsupported options and invalid values', () => {
  assert.throws(() => parseCliArgs(['--not-supported']), /Unknown option/);
  assert.throws(() => parseCliArgs(['--model']), /requires a value/);
  assert.throws(() => parseCliArgs(['--max-turns', '0']), /positive integer/);
  assert.throws(() => parseCliArgs(['--max-turns', '1.5']), /positive integer/);
  assert.throws(() => parseCliArgs(['--output-format', 'stream-json']), /must be "text" or "json"/);
  assert.throws(() => parseCliArgs(['--help', '--verbose']), /must be used on its own/);
});
