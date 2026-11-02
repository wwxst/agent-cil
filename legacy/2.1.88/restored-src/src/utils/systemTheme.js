// Node compatibility boundary for the original 2.1.88 ThemeProvider.
// The current agent-cil TUI has a fixed dark palette; auto terminal probing
// is intentionally not enabled until its settings lifecycle is ported.
export function getSystemThemeName() {
  return 'dark';
}
