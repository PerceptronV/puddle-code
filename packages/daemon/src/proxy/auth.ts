export function stripProxyCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader.split(';').filter((part) => {
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    return name !== 'puddle_proxy' && !name.startsWith('puddle_proxy_');
  });
  const joined = kept
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('; ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * Remove Puddle credential pairs from a raw query string (with or without
 * its leading `?`), returning the rest byte-intact — pairs are spliced out
 * textually, never decoded/re-encoded. Legacy credentials must not reach
 * application request lines or access logs even though they no longer
 * authenticate any Puddle route.
 * Returns `''` when nothing remains.
 */
export function stripTokenParam(search: string): string {
  if (search === '' || search === '?') return search;
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const kept = raw.split('&').filter((pair) => {
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    // Also remove percent-encoded credential names. Malformed escapes cannot
    // match a Puddle parameter and remain byte-intact.
    let name = rawName;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      /* malformed percent-escape — cannot be `puddle_token`, keep raw */
    }
    return !['puddle_token', 'puddle_invite'].includes(name);
  });
  return kept.length > 0 ? `?${kept.join('&')}` : '';
}
