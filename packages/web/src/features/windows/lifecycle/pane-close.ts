let handler: ((signal: AbortSignal) => Promise<void>) | null = null;
let active: AbortController | null = null;

export function registerPaneClose(handlerForWorkspace: (signal: AbortSignal) => Promise<void>) {
  handler = handlerForWorkspace;
  return () => {
    if (handler !== handlerForWorkspace) return;
    cancelPaneClose();
    handler = null;
  };
}

export function cancelPaneClose() {
  active?.abort();
  active = null;
}

/** Acknowledge dispatch immediately; a human dialogue never occupies the IPC queue. */
export function requestPaneClose(report: (error: unknown) => void) {
  if (active) return;
  if (!handler) throw new Error('Wait for this pane to finish loading before closing it');
  const attempt = new AbortController();
  active = attempt;
  void handler(attempt.signal)
    .catch(report)
    .finally(() => {
      if (active === attempt) active = null;
    });
}
