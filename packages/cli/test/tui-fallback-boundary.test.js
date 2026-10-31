import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('original Ink startup fallback cannot replay a positional prompt after runtime side effects', async () => {
  // This structural guard complements the npm-packed real-PTY coding test:
  // any thrown runtime error must leave through the AgentLoop/journal finally
  // owner, not into the pre-execution readline bootstrap fallback.
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const begin = source.indexOf(
    "const { startAgentTui } = await import('./tui/entry.js');");
  const fallback = source.indexOf(
    "printLocalizedError('Could not start the original Ink TUI;", begin);
  const runtime = source.indexOf(
    'if (tui) {\n      // The positional prompt is already committed', fallback);
  assert.ok(begin > 0 && fallback > begin && runtime > fallback,
    'startup-only fallback must finish before the live TUI begins running the user prompt');
  const startupOnly = source.slice(begin, runtime);
  assert.doesNotMatch(startupOnly, /await runPrompt\(/,
    'a positional first prompt must never execute inside the readline bootstrap catch');
  const activeTui = source.slice(runtime, runtime + 850);
  assert.match(activeTui,
    /await runPrompt\(initialInputCommitted \? undefined : prompt/,
    'TUI must not duplicate the fsynced initial user prompt on replay');
  assert.match(activeTui, /await tui\.waitUntilExit\(\)/,
    'live terminal errors must leave via the runtime/journal finally owner');
});
