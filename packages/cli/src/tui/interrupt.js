export const TUI_DOUBLE_PRESS_TIMEOUT_MS = 800;

export function createTuiInterruptHandler({
  getActiveController,
  onCancelMessage = () => {},
  onExit = () => {},
  now = Date.now,
  timeoutMs = TUI_DOUBLE_PRESS_TIMEOUT_MS,
}) {
  let lastIdleInterruptAt = 0;

  return function handleTuiInterrupt() {
    const activeController = getActiveController();
    if (activeController && !activeController.signal.aborted) {
      lastIdleInterruptAt = 0;
      const error = new Error('Interrupted by user.');
      error.name = 'AbortError';
      activeController.abort(error);
      return 'cancelled';
    }

    const currentTime = now();
    if (activeController) {
      // The abort signal has fired, but the AgentLoop still owns tool and
      // process cleanup. Arm the idle exit window without closing that owner.
      if (
        lastIdleInterruptAt === 0 ||
        currentTime - lastIdleInterruptAt > timeoutMs
      ) {
        lastIdleInterruptAt = currentTime;
        onCancelMessage();
      }
      return 'waiting-for-cleanup';
    }

    if (
      lastIdleInterruptAt !== 0 &&
      currentTime - lastIdleInterruptAt <= timeoutMs
    ) {
      lastIdleInterruptAt = 0;
      onExit();
      return 'exit';
    }

    lastIdleInterruptAt = currentTime;
    onCancelMessage();
    return 'armed';
  };
}
