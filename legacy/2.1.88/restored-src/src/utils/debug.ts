// agent-cil adapter for the original Ink debug hook.
export function logForDebugging(message: string): void {
  if (process.env.AGENT_CIL_DEBUG_TUI === '1') process.stderr.write('[tui:debug] ' + message + '\n');
}
