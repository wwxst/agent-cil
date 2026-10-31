import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('original Ink startup fallback cannot replay a positional prompt after runtime side effects', async () => {
  // This structural guard complements the npm-packed real-PTY coding test:
  // any thrown runtime error must leave through the AgentLoop/journal finally
  // owner, not into the pre-execution readline bootstrap fallback.
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const begin = source.indexOf('// Only the Ink bootstrap may fall back to readline.');
  const fallback = source.indexOf("printLocalizedError('Could not start the original Ink TUI;", begin);
  const runtime = source.indexOf('if (tui) {\n      // Runtime failures propagate through the existing AgentLoop/session', fallback);
  assert.ok(begin > 0 && fallback > begin && runtime > fallback,
    'startup-only fallback must end before the active TUI runtime');
  const startupOnly = source.slice(begin, runtime);
  assert.doesNotMatch(startupOnly, /await runPrompt\(prompt\)/,
    'a positional prompt must never execute inside the readline-fallback catch scope');
  assert.match(source.slice(runtime, runtime + 650), /await runPrompt\(prompt\)/);
  assert.match(source.slice(runtime, runtime + 650), /await tui\.waitUntilExit\(\)/);
});
