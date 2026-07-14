import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expands a leading ~ against the daemon host's home directory. Only the
 * daemon can do this — the browser has no idea where home is on the host.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
