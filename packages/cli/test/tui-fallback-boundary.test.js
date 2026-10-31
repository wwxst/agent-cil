import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('original Ink startup fallback cannot replay a positional prompt after runtime side effects', async () => {
  // Retain the structural guard over the current, source-preserving 2.1.88
  // Ink bootstrap + newer journal checkpoint chain. A failed bootstrap may
  // choose readline, but a completed/failed AgentLoop run must not enter catch.
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const begin = source.indexOf('// Only bootstrap failure may fall back to readline.');
  const fallback = source.indexOf(
    "printLocalizedError('Could not start the original Ink TUI;", begin);
  const runtime = source.indexOf('    if (tui) {\n      if (prompt) {', fallback);
  assert.ok(begin > 0 && fallback > begin && runtime > fallback,
    'source Ink bootstrap catch must precede the separately owned runtime');
  const bootstrap = source.slice(begin, runtime);
  assert.doesNotMatch(bootstrap, /await runPrompt\(/,
    'neither the Ink startup try nor its fallback catch may run a provider turn');
  assert.match(bootstrap, /tui = await startAgentTui\(/);
  assert.match(bootstrap, /rl = createInterface\(/);
  const active = source.slice(runtime, runtime + 900);
  assert.match(active, /await runPrompt\(initialInputCommitted \? undefined : prompt\)/,
    'a persisted initial input must never be passed a second time');
  assert.match(active, /await tui\.waitUntilExit\(\)/);
  assert.match(source, /await journal\.append\(\{\s*messages:\[\{role:'user',content:prompt\}\],kind:'input'/,
    'current core must durably commit its initial prompt before TUI startup');
});
