/** Trailing-edge debounce with flush/cancel, for the ui_state writer. */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Run a pending call now instead of waiting out the delay. */
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const debounced = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args2 = lastArgs!;
      lastArgs = null;
      fn(...args2);
    }, ms);
  };
  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const args = lastArgs!;
    lastArgs = null;
    fn(...args);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}
