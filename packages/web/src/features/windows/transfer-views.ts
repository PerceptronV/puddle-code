/**
 * View stores prefix a scoped JSON key with their namespace. Its first element
 * is the pane context `[profile:layoutScope, paneId, tabKey]`. Transfer only the
 * selected pane's keys, keeping surface/target identities and transport scope.
 */
export function transferPaneViews(
  views: Record<string, unknown>,
  panes: ReadonlyMap<string, string>,
  fromScope: string,
  toScope: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(views)) {
    const start = key.indexOf('[');
    if (start < 0) continue;
    try {
      const outer: unknown = JSON.parse(key.slice(start));
      if (!Array.isArray(outer) || outer.length !== 3 || typeof outer[0] !== 'string') continue;
      const tab: unknown = JSON.parse(outer[0]);
      if (
        !Array.isArray(tab) ||
        tab.length !== 3 ||
        typeof tab[0] !== 'string' ||
        typeof tab[1] !== 'string' ||
        typeof tab[2] !== 'string' ||
        !tab[0].endsWith(`:${fromScope}`)
      )
        continue;
      const paneId = panes.get(tab[1]);
      if (!paneId) continue;
      const channel = `${tab[0].slice(0, -fromScope.length)}${toScope}`;
      result[
        key.slice(0, start) +
          JSON.stringify([JSON.stringify([channel, paneId, tab[2]]), ...outer.slice(1)])
      ] = value;
    } catch {
      // Older/unknown view adapters remain in their source recovery snapshot.
    }
  }
  return result;
}
