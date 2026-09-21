import type { IncomingMessage, ServerResponse } from 'node:http';
import { proxyExchangeSchema } from '@puddle/shared';
import type { ConnectionAuthority } from '../auth/connection-authority.js';
import type { BrowserAuthority } from './browser-authority.js';
import { exactOrigin, fail, json, readJson } from './http-auth.js';
import { recoverProxiedPath } from './proxy-recovery.js';
import { proxyRequest, type ProxyTarget } from './proxy.js';

export const proxyPrefix = (path: string): string | null =>
  /^\/proxy\/[a-f0-9-]{36}\/\d+\//.exec(path)?.[0] ?? null;

/** No cockpit routes or assets are ever served at the application origin. */
export async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  browsers: BrowserAuthority,
  authority: ConnectionAuthority,
  target: ProxyTarget,
): Promise<void> {
  if (!exactOrigin(req, origin, !['GET', 'HEAD'].includes(req.method ?? '')))
    return fail(res, 403, 'forbidden_origin');
  const url = new URL(req.url ?? '/', origin);
  const prefix = proxyPrefix(url.pathname);
  if (!prefix) {
    const referer = req.headers.referer;
    const recovery =
      referer && new URL(referer).origin === origin
        ? recoverProxiedPath(referer, req.url ?? '/')
        : null;
    if (recovery) {
      res.writeHead(307, { location: recovery });
      res.end();
      return;
    }
    return fail(res, 404, 'not_found');
  }
  if (url.pathname === `${prefix}_puddle/enter` && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>Opening forwarded application</title><p id="status">Opening application…</p><script>
const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
history.replaceState(null, '', location.pathname);
fetch('./exchange', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invitation})})
.then(async r => {if(!r.ok) throw Error('Open the forwarding link from Puddle again.'); const result = await r.json(); location.replace(result.url);})
.catch(() => {document.getElementById('status').textContent='Open the forwarding link from Puddle again.';});
</script>`);
    return;
  }
  if (url.pathname === `${prefix}_puddle/exchange` && req.method === 'POST') {
    if (!exactOrigin(req, origin, true)) return fail(res, 403, 'forbidden_origin');
    if (authority.state !== 'ready') return fail(res, 503, authority.state);
    const body = proxyExchangeSchema.parse(await readJson(req));
    const grant = browsers.exchangeProxy(body.invitation, prefix);
    if (!grant) return fail(res, 401, 'browser_rejected');
    res.setHeader('set-cookie', grant.cookie);
    json(res, 200, { url: origin + grant.path });
    return;
  }
  const browser = browsers.proxyBrowser(req.headers.cookie, prefix);
  if (!browser)
    return fail(res, 401, 'browser_rejected', 'Open this forwarding link from Puddle again.');
  if (authority.state !== 'ready') return fail(res, 503, authority.state);
  proxyRequest(req, res, target, { authority, browsers, browser }, true);
}
