// agent-cil compatibility boundary for the original Ink runtime.
let lastInteractionAt = Date.now();
export function flushInteractionTime(): void { /* no bootstrap metrics collector in agent-cil */ }
export function updateLastInteractionTime(): void { lastInteractionAt = Date.now(); }
export function getLastInteractionTime(): number { return lastInteractionAt; }
export function getIsInteractive(): boolean { return Boolean(process.stdin.isTTY && process.stdout.isTTY); }
