function detectTerminal() {
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM;
  if (process.env.TERM?.includes('kitty')) return 'kitty';
  if (process.env.TERM === 'xterm-ghostty') return 'ghostty';
  if (process.env.TMUX) return 'tmux';
  if (process.env.STY) return 'screen';
  return null;
}

// Narrow Node-host compatibility surface consumed by the original 2.1.88
// input hook. Do not import the full Bun-oriented runtime environment here.
export const env = Object.freeze({
  terminal: detectTerminal(),
  platform: process.platform,
  isRunningWithBun: () => false,
});
