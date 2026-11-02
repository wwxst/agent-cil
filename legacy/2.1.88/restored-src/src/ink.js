// Node compatibility barrel for the original 2.1.88 MarkdownTable component.
// The full REPL ink.ts barrel mounts global config-backed ThemeProvider; the
// agent-cil TUI currently uses a fixed dark palette and the existing Ink root.
export { Ansi } from './ink/Ansi.js';
export { default as Box } from './ink/components/Box.js';
export { default as Text } from './ink/components/Text.js';

export function useTheme() {
  return ['dark', () => {}];
}
