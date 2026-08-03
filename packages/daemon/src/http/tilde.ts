import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Expands a leading ~ against the daemon host's home directory. Only the
 * daemon can do this — the browser has no idea where home is on the host.
 * A trailing slash survives expansion: `join` normalises it away, but for
 * directory autocomplete it is load-bearing — `~/` must list home's contents,
 * not complete home's basename inside its parent.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) {
    const expanded = join(homedir(), path.slice(2));
    return path.endsWith('/') && !expanded.endsWith('/') ? `${expanded}/` : expanded;
  }
  return path;
}
