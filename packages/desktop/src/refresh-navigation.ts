/** Preserve the route when a replacement cockpit must use a different origin. */
export function refreshNavigation(
  previous: string,
  oldOrigin: string,
  next: {
    origin: string;
    createInvitation(): string;
  },
  refreshId?: string,
): string | null {
  if (next.origin === oldOrigin && refreshId) return null;
  const route = new URL(previous);
  const target = new URL(next.origin === oldOrigin ? next.origin : next.createInvitation());
  const host = target.searchParams.get('host');
  if (route.origin === oldOrigin) {
    target.pathname = route.pathname;
    target.search = route.search;
    if (host !== null) target.searchParams.set('host', host);
  }
  return target.href;
}
