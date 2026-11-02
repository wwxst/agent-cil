// Environment compatibility surface consumed by the original 2.1.88 Ink.
function detectTerminal(): string | undefined {
  const program = process.env.TERM_PROGRAM;
  if (program === 'iTerm.app') return 'iTerm.app';
  if (program === 'WezTerm') return 'WezTerm';
  if (program === 'ghostty') return 'ghostty';
  if (program === 'vscode') return 'vscode';
  if (process.env.KITTY_WINDOW_ID || process.env.TERM?.includes('kitty')) return 'kitty';
  if (process.env.TMUX || process.env.TERM?.includes('tmux')) return 'tmux';
  if (process.env.WT_SESSION) return 'windows-terminal';
  return program || process.env.TERM || undefined;
}
export const env: NodeJS.ProcessEnv & { terminal?: string } = Object.assign({}, process.env, { terminal: detectTerminal() });
