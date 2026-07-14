import { clientSettings } from './client-settings';
import { localValue } from './local-store';

/**
 * "Open in editor" deep links (SPEC §7): VS Code and Cursor both understand
 * the same `vscode-remote` remote-authority scheme (Cursor is a VS Code
 * fork), so only the URI scheme itself (`vscode:` vs `cursor:`) varies.
 */
export type Editor = 'vscode' | 'cursor';

/**
 * `worktreePath` is always absolute (`/Users/alice/proj`), so plain
 * concatenation after `file` produces the correct single-slash shape
 * (`vscode://file/Users/alice/proj`) without an extra separator.
 */
export function editorDeepLink(
  editor: Editor,
  worktreePath: string,
  sshHost: string | null,
): string {
  if (sshHost) {
    return `${editor}://vscode-remote/ssh-remote+${sshHost}${worktreePath}`;
  }
  return `${editor}://file${worktreePath}`;
}

/**
 * The CLI starts sending `?host=` at boot in Phase 6; until then (or for a
 * manual `ssh -L` user it will never cover) the client setting wins.
 */
export function resolveEditorHost(settingHost: string, storedHost: string | null): string | null {
  if (settingHost) return settingHost;
  if (storedHost) return storedHost;
  return null;
}

/** Captured once at boot from `?host=`, kept across reloads (`bootstrapToken`'s sibling). */
export const hostParamStore = localValue('puddle.host');

export function editorLinkHost(): string | null {
  return resolveEditorHost(clientSettings().editorLinkSshHost, hostParamStore.get());
}

/** Pure extraction so it's testable without a DOM; trims and treats blank as absent. */
export function parseHostParam(search: string): string | null {
  const host = new URLSearchParams(search).get('host')?.trim();
  return host ? host : null;
}

/**
 * Mirrors `bootstrapToken` (`src/lib/auth.ts`): read `?host=` once, store it,
 * and strip it from the address bar via `history.replaceState` (the CLI's
 * connect-time param shouldn't linger in history or survive a copy-paste of
 * the URL).
 */
export function captureHostParam(): void {
  const host = parseHostParam(window.location.search);
  if (!host) return;
  hostParamStore.set(host);
  const url = new URL(window.location.href);
  url.searchParams.delete('host');
  history.replaceState(null, '', url);
}
