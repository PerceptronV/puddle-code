import { isLocalHostHeader } from './guard.js';

/**
 * Recovery for proxied apps that reference absolute paths. A page served from
 * /proxy/<sid>/<port>/ resolves absolute URLs — <script src="/assets/main.js">,
 * fetch('/api/…') — against the cockpit origin, escaping the proxy prefix; the
 * request would otherwise be answered by puddle's own SPA fallback (an HTML
 * body where a module script was expected). The Referer names the proxied page
 * the request came from, so strays are sent back under their prefix with a 307
 * (method- and body-preserving). A redirect, not a transparent forward, on
 * purpose: the recovered URL becomes the subresource's own base, so its
 * relative imports resolve under the prefix without another round trip here.
 *
 * This replaces HTML/asset rewriting, which SPEC §9 deliberately rejects: the
 * proxy stays byte-transparent, and only requests that have already escaped
 * are touched. Known residue: WebSocket handshakes and no-referrer policies
 * carry no Referer and cannot be recovered — the per-port `ssh -L` fallback
 * in the ports strip remains the escape hatch for those apps.
 */

const PROXY_PAGE = /^\/proxy\/([^/]+)\/(\d+)(?:\/|$)/;

/**
 * The /proxy/<sid>/<port> prefix to bounce this request under, or null when
 * the request is not a stray subresource of a proxied page.
 */
export function recoverProxiedPath(
  referer: string | string[] | undefined,
  requestUrl: string,
): string | null {
  if (typeof referer !== 'string' || !requestUrl.startsWith('/')) return null;
  const pathname = requestUrl.split('?')[0] ?? '';
  // Already addressed to the proxy (or to its namespace) — nothing to recover,
  // and never rewriting /proxy/* is what makes a redirect loop impossible.
  if (pathname === '/proxy' || pathname.startsWith('/proxy/')) return null;
  let ref: URL;
  try {
    ref = new URL(referer);
  } catch {
    return null;
  }
  // Only pages this cockpit itself served can claim a stray (defence in
  // depth — a foreign page cannot forge a localhost Referer, but be strict).
  if (!isLocalHostHeader(ref.host)) return null;
  const match = PROXY_PAGE.exec(ref.pathname);
  if (match === null) return null;
  return `/proxy/${match[1]}/${match[2]}${requestUrl}`;
}
