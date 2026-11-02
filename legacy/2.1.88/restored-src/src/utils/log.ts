// agent-cil adapter for errors raised inside the original Ink renderer.
export function logError(error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write('[tui:error] ' + message + '\n');
}
