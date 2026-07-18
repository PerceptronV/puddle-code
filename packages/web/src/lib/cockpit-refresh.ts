import { cockpitRefreshResponseSchema } from '@puddle/shared';
import { tokenStore } from './auth';

/**
 * The cockpit's refresh control (SPEC §10): `POST /cockpit/refresh` is served
 * by the CLI's UI server at this page's own origin — NOT proxied to the
 * daemon — and makes the cockpit replace itself (kill + full start/connect,
 * restarting a dead tunnel or daemon along the way). This module owns the two
 * HTTP steps plus a trigger registry so the ⌘K palette can drive the banner's
 * flow without threading props across the shell.
 */

/** Asks the cockpit to replace itself; true when it accepted (202). */
export async function requestCockpitRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/cockpit/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenStore.get() ?? ''}` },
    });
    if (res.status !== 202) return false;
    cockpitRefreshResponseSchema.parse(await res.json());
    return true;
  } catch {
    // The cockpit itself is gone (nothing listens on this origin), or the
    // response was not its own — either way the swap cannot be driven from
    // here; the caller points at the terminal instead.
    return false;
  }
}

/**
 * Polls until the origin answers again. ANY HTTP response to /api/version —
 * even the daemon's 401 — proves the whole path (new cockpit, tunnel, daemon)
 * is back; while the old cockpit is dead and the new one is binding, the
 * fetch itself rejects. Resolves false on timeout (the replacement may need a
 * terminal, e.g. interactive ssh re-auth a detached process cannot do).
 */
export async function waitForCockpitBack(timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await fetch('/api/version', { cache: 'no-store' });
      return true;
    } catch {
      // Still down — keep polling.
    }
  }
  return false;
}

/* -- Trigger registry (same shape as lib/command-palette.ts) -------------- */

let trigger: (() => void) | null = null;

/** The connection banner registers its refresh flow here (one at a time). */
export function registerRefreshTrigger(fn: () => void): () => void {
  trigger = fn;
  return () => {
    if (trigger === fn) trigger = null;
  };
}

/** Fire the registered refresh flow (the ⌘K "Refresh connection" command). */
export function triggerConnectionRefresh(): void {
  trigger?.();
}
