import { execFileSync } from 'node:child_process';

const ALL_WORKSPACES = 0xffff_ffff;

type XpropRunner = (args: string[]) => string;

const runXprop: XpropRunner = (args) =>
  execFileSync('xprop', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000,
  });

/** Electron media ids carry the X11 Window as their first numeric field. */
export function x11WindowId(mediaSourceId: string): string | null {
  return /^window:(\d+):/.exec(mediaSourceId)?.[1] ?? null;
}

export function parseX11Workspace(output: string): number | null {
  const raw = /=\s*(0x[\da-f]+|\d+)\s*$/i.exec(output.trim())?.[1];
  if (!raw) return null;
  const workspace = Number(raw);
  if (!Number.isInteger(workspace) || workspace < 0 || workspace >= ALL_WORKSPACES) return null;
  return workspace;
}

/** Read one EWMH workspace; null also means native Wayland or missing xprop. */
export function readX11Workspace(
  mediaSourceId: string,
  runner: XpropRunner = runXprop,
): number | null {
  const id = x11WindowId(mediaSourceId);
  if (!id) return null;
  try {
    return parseX11Workspace(runner(['-id', id, '_NET_WM_DESKTOP']));
  } catch {
    return null;
  }
}

/**
 * Set the hint while the BrowserWindow is still unmapped. EWMH window managers
 * then place it directly on that workspace without switching the user's
 * current desktop. Failure is an honest no-op (native Wayland, no xprop, or a
 * non-EWMH window manager).
 */
export function restoreX11Workspace(
  mediaSourceId: string,
  workspace: number,
  runner: XpropRunner = runXprop,
): boolean {
  const id = x11WindowId(mediaSourceId);
  if (!id || !Number.isInteger(workspace) || workspace < 0 || workspace >= ALL_WORKSPACES) {
    return false;
  }
  try {
    runner([
      '-id',
      id,
      '-f',
      '_NET_WM_DESKTOP',
      '32c',
      '-set',
      '_NET_WM_DESKTOP',
      String(workspace),
    ]);
    return true;
  } catch {
    return false;
  }
}
