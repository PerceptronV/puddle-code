import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ShellTheme = 'light' | 'dark' | 'system';
export function isShellTheme(value: unknown): value is ShellTheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Last cockpit preference, available before any host can connect. */
export function loadShellTheme(file: string): ShellTheme {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isShellTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}
export function saveShellTheme(file: string, theme: ShellTheme): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(theme) + '\n', { mode: 0o600 });
  } catch {
    // Appearance persistence must not prevent connecting to a host.
  }
}
