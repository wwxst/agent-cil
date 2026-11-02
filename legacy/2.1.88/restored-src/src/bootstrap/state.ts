// agent-cil compatibility boundary for the original Ink runtime.
let lastInteractionAt = Date.now();
let scrollDraining = false;
let scrollDrainTimer;
const SCROLL_DRAIN_IDLE_MS = 150;

export function flushInteractionTime(): void { /* no bootstrap metrics collector in agent-cil */ }
export function updateLastInteractionTime(): void { lastInteractionAt = Date.now(); }
export function getLastInteractionTime(): number { return lastInteractionAt; }
export function getIsInteractive(): boolean { return Boolean(process.stdin.isTTY && process.stdout.isTTY); }

// Match the original 2.1.88 bootstrap/state.ts contract used by ScrollBox.
// Background work in agent-cil can gate on this while the terminal is scrolling.
export function markScrollActivity(): void {
  scrollDraining = true;
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer);
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false;
    scrollDrainTimer = undefined;
  }, SCROLL_DRAIN_IDLE_MS);
  scrollDrainTimer.unref?.();
}

export function getIsScrollDraining(): boolean {
  return scrollDraining;
}
