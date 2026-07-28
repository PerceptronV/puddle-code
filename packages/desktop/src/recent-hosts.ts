import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Recently connected ssh targets for the File → Recent Hosts submenu, stored
 * as a JSON string array in the app's userData dir. Purely a convenience
 * list — hostnames only, never credentials (auth is the system ssh's job).
 */

const MAX_RECENTS = 8;

export function loadRecentHosts(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((h): h is string => typeof h === 'string').slice(0, MAX_RECENTS);
  } catch {
    return []; // missing or corrupt — start fresh
  }
}

export function addRecentHost(file: string, host: string): string[] {
  const next = [host, ...loadRecentHosts(file).filter((h) => h !== host)].slice(0, MAX_RECENTS);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Best-effort: an unwritable userData dir must not break connecting.
  }
  return next;
}
