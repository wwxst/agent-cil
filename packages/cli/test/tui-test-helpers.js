import stripAnsi from 'strip-ansi';

// Ink emits cursor-forward sequences for spaces in its incremental terminal
// renderer. strip-ansi removes those sequences, so restore their visual width
// before matching user-visible TUI text in PTY tests.
export function normalizeTuiOutput(output) {
  const withCursorSpaces = String(output ?? '').replace(
    /\x1b\[(\d*)C/g,
    (_sequence, count) => ' '.repeat(Number(count || 1)),
  );
  return stripAnsi(withCursorSpaces);
}
