// The original CLI buffers keystrokes before mounting the REPL. agent-cil
// starts Ink before accepting interactive input, so there is no early buffer.
export function stopCapturingEarlyInput(): void {}
