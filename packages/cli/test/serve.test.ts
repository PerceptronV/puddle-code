import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startDaemon, type RunningDaemon } from '../../daemon/src/daemon.js';
import { startUiServer, type UiServer } from '../src/lib/serve/ui-server.js';
import { isLocalHostHeader, isLocalOrigin } from '../src/lib/serve/guard.js';

function withAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-cli-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>puddle</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');
  return dir;
}

describe('guard predicates', () => {
  it('accepts local hosts on any port and rejects foreign ones', () => {
    expect(isLocalHostHeader('localhost:7433')).toBe(true);
    expect(isLocalHostHeader('127.0.0.1:9999')).toBe(true);
    expect(isLocalHostHeader('[::1]:7433')).toBe(true);
    expect(isLocalHostHeader('evil.example.com:7433')).toBe(false);
    expect(isLocalHostHeader(undefined)).toBe(false);
  });
  it('accepts absent/null/local Origins, rejects foreign', () => {
    expect(isLocalOrigin(undefined)).toBe(true);
    expect(isLocalOrigin('null')).toBe(true);
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('https://evil.example.com')).toBe(false);
    expect(isLocalOrigin(':::garbage')).toBe(false);
  });
});

describe('UI server in front of a real daemon', () => {
  let daemon: RunningDaemon;
  let ui: UiServer;
  let refreshes = 0;

  beforeAll(async () => {
    daemon = await startDaemon({
      home: mkdtempSync(join(tmpdir(), 'puddle-cli-home-')),
      port: 0,
      adapters: [],
      version: 'cli-test',
    });
    ui = await startUiServer({
      assetsDir: withAssets(),
      port: 0 + 17500, // fixed-ish start; auto-picks the next free
      target: { host: '127.0.0.1', port: daemon.port },
      control: { token: 'control-token', onRefresh: () => (refreshes += 1) },
    });
  });
  afterAll(async () => {
    await ui.close();
    await daemon.stop();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${ui.port}${path}`, {
      headers: { host: `localhost:${ui.port}`, ...headers },
    });

  it('serves the UI tokenlessly with SPA fallback and confinement', async () => {
    expect(await (await get('/')).text()).toContain('puddle');
    expect((await get('/assets/app.js')).headers.get('content-type')).toContain('javascript');
    expect(await (await get('/project/42')).text()).toContain('puddle');
    const escape = await get('/assets/..%2f..%2f..%2f..%2fetc%2fpasswd');
    expect(await escape.text()).not.toContain('root:');
  });

  it('404s a missing asset instead of SPA-falling-back to HTML', async () => {
    const missing = await get('/assets/index-abc123.js');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).not.toContain('text/html');
  });

  it('recovers a proxied page’s stray absolute-path requests via 307', async () => {
    const referer = `http://localhost:${ui.port}/proxy/sess-1/3000/`;
    const strayAsset = await fetch(`http://127.0.0.1:${ui.port}/assets/main.js`, {
      headers: { host: `localhost:${ui.port}`, referer },
      redirect: 'manual',
    });
    expect(strayAsset.status).toBe(307);
    expect(strayAsset.headers.get('location')).toBe('/proxy/sess-1/3000/assets/main.js');

    // Absolute fetch('/api/…') from the proxied app belongs to the app, not
    // to puddle's API — it is recovered too, query string intact.
    const strayApi = await fetch(`http://127.0.0.1:${ui.port}/api/items?page=2`, {
      method: 'POST',
      headers: { host: `localhost:${ui.port}`, referer },
      redirect: 'manual',
    });
    expect(strayApi.status).toBe(307);
    expect(strayApi.headers.get('location')).toBe('/proxy/sess-1/3000/api/items?page=2');
  });

  it('leaves puddle’s own requests and non-proxied referers alone', async () => {
    // The web UI's own API calls carry a non-proxy Referer: proxied verbatim.
    const own = await get('/api/version', {
      referer: `http://localhost:${ui.port}/project/42`,
      authorization: `Bearer ${daemon.token}`,
    });
    expect(own.status).toBe(200);
    // A request already under /proxy/ is never rewritten (no redirect loops).
    const already = await fetch(`http://127.0.0.1:${ui.port}/proxy/sess-1/3000/x.js`, {
      headers: {
        host: `localhost:${ui.port}`,
        referer: `http://localhost:${ui.port}/proxy/sess-1/3000/`,
      },
      redirect: 'manual',
    });
    expect(already.status).not.toBe(307);
    // A foreign Referer host never claims a stray.
    const foreign = await get('/assets/main.js', {
      referer: 'https://evil.example.com/proxy/sess-1/3000/',
    });
    expect(foreign.status).toBe(404);
  });

  it('proxies /api verbatim: bearer passes through, daemon auth still applies', async () => {
    const ok = await get('/api/version', { authorization: `Bearer ${daemon.token}` });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { version: string };
    expect(body.version).toBe('cli-test');
    expect((await get('/api/version')).status).toBe(401); // daemon's 401, proxied
  });

  it('applies Host/Origin checks at the CLI port before proxying', async () => {
    // fetch strips Host (a spec-forbidden header) — send the DNS-rebinding
    // shape with a raw node:http request instead.
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: ui.port,
          path: '/api/version',
          headers: { host: 'evil.example.com', authorization: `Bearer ${daemon.token}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(badHostStatus).toBe(403);
    const badOrigin = await get('/api/version', {
      origin: 'https://evil.example.com',
      authorization: `Bearer ${daemon.token}`,
    });
    expect(badOrigin.status).toBe(403);
  });

  it('POST /cockpit/refresh: token-gated, 202 fires the callback exactly once', async () => {
    const before = refreshes;
    // Wrong or missing token → 401, no callback.
    const post = (headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${ui.port}/cockpit/refresh`, {
        method: 'POST',
        headers: { host: `localhost:${ui.port}`, ...headers },
      });
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
    // Non-POST → 405; foreign Origin → 403 (same discipline as /api).
    expect((await get('/cockpit/refresh', { authorization: 'Bearer control-token' })).status).toBe(
      405,
    );
    expect(
      (
        await post({
          authorization: 'Bearer control-token',
          origin: 'https://evil.example.com',
        })
      ).status,
    ).toBe(403);
    expect(refreshes).toBe(before);
    // The real thing: 202 with the refreshing body, callback fired.
    const accepted = await post({ authorization: 'Bearer control-token' });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: 'refreshing' });
    await new Promise((resolve) => setImmediate(resolve)); // the deferred callback
    expect(refreshes).toBe(before + 1);
  });

  it('synthesises a daemon_unreachable 502 when the target is down', async () => {
    ui.setTarget({ host: '127.0.0.1', port: 1 }); // nothing listens there
    const res = await get('/api/version', { authorization: `Bearer ${daemon.token}` });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('daemon_unreachable');
    ui.setTarget({ host: '127.0.0.1', port: daemon.port });
    expect((await get('/api/version', { authorization: `Bearer ${daemon.token}` })).status).toBe(
      200,
    );
  });

  it('splices the /ws upgrade through to the daemon gateway', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/ws`, {
      headers: { host: `localhost:${ui.port}` },
    });
    const messages: Array<{ t: string }> = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as { t: string }));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // Auth then attach to a nonexistent session: the daemon's error frame
    // proves both directions of the splice.
    ws.send(JSON.stringify({ t: 'auth', token: daemon.token }));
    ws.send(JSON.stringify({ t: 'attach', session: 'nope', term: 'agent', cols: 80, rows: 24 }));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some((m) => m.t === 'error')) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    expect(messages.some((m) => m.t === 'error')).toBe(true);
    ws.close();
  });

  it('refuses a WS upgrade with a foreign Host at the CLI port', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ui.port}/ws`, {
      headers: { host: 'evil.example.com' },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', (e) => resolve(String(e)));
    });
    expect(outcome).toContain('403');
  });
});
