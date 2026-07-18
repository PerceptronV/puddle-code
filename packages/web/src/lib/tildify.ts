/**
 * Compress the daemon home-directory prefix to `~` for display (SPEC §8) —
 * `home` comes from `GET /api/host`, so it is the DAEMON user's home whatever
 * the OS layout (`/home/<user>` on Linux, `/Users/<user>` on macOS). Only a
 * whole-segment prefix qualifies: `/Users/alice-backup` is not inside
 * `/Users/alice`. Pure and DOM-free — unit-testable.
 */
export function tildify(path: string, home: string | undefined): string {
  if (!home) return path;
  const root = home.endsWith('/') ? home.slice(0, -1) : home;
  if (root === '' || root === '/') return path;
  if (path === root) return '~';
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}
