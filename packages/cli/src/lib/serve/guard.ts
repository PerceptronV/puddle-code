/**
 * Host/Origin predicates, identical to the daemon's
 * (packages/daemon/src/security/middleware.ts): the CLI's UI server applies
 * the same two checks on its own port (SPEC §2 "Local security" point 2).
 * Ports are deliberately ignored — the UI origin's port is whatever the CLI
 * picked, never the daemon's.
 */

/** WHATWG URL keeps brackets on IPv6 hostnames, hence both spellings. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

/** Whether the `Host` header names a local machine (defeats DNS rebinding). */
export function isLocalHostHeader(host: string | undefined): boolean {
  return LOCAL_HOSTNAMES.has(hostnameOf(host ?? ''));
}

/** Whether an `Origin` header is acceptable: absent, `'null'`, or localhost. */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
