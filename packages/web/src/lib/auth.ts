import { localValue } from './local-store';

/**
 * Daemon bearer token. `puddle start` opens the UI as `/#token=<hex>`; the
 * fragment is captured once, stripped from the URL (fragments never reach the
 * server, but they linger in history), and kept in localStorage.
 */
export const tokenStore = localValue('puddle.token');

export function bootstrapToken(): void {
  const match = /[#&]token=([0-9a-fA-F]+)/.exec(window.location.hash);
  if (!match) return;
  tokenStore.set(match[1]!);
  const url = new URL(window.location.href);
  url.hash = '';
  history.replaceState(null, '', url);
}

/** A 401 means the stored token is stale: drop it and return to the gate. */
export function clearToken(): void {
  tokenStore.set(null);
}
