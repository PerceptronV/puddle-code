import WebSocket from 'ws';
import { afterEach, expect, it } from 'vitest';
import { fixture, createSession, sleep, until, websocket } from './helpers.js';

let running: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

it('renews active terminals, HTTP streams and isolated proxy WebSockets across token rotation', async () => {
  const f = (running = await fixture());
  const session = await createSession(f);
  const terminal = await websocket(f.origin, f.credential);
  terminal.send({ t: 'attach', session: session.id, term: 'agent', cols: 100, rows: 24 });
  const output = await until(
    () =>
      terminal.messages
        .filter((m) => m.t === 'replay' || m.t === 'output')
        .map((m) => ('data' in m ? m.data : ''))
        .join(''),
    (text) => /PORT:\d+/.test(text),
  );
  const port = Number(/PORT:(\d+)/.exec(output)![1]);
  const proxyOrigin = `http://127.0.0.1:${f.uiPort}`;
  const prefix = `/proxy/${session.id}/${port}/`;
  const response = await f.req('/cockpit/proxy-grant', {
    method: 'POST',
    body: JSON.stringify({ session: session.id, port, path: '/app?keep=yes' }),
  });
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const invite = new URLSearchParams(new URL(url).hash.slice(1)).get('invite');
  const exchange = (origin = proxyOrigin) =>
    fetch(`${proxyOrigin}${prefix}_puddle/exchange`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ invitation: invite }),
    });
  expect((await exchange(f.origin)).status).toBe(403);
  expect((await fetch(`${f.origin}${prefix}`)).status).toBe(404);
  const boot = await exchange();
  expect(boot.status).toBe(200);
  const setCookie = boot.headers.get('set-cookie')!;
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain(`Path=${prefix}`);
  expect(setCookie).not.toContain('Domain=');
  const cookie = setCookie.split(';')[0]!;
  expect((await exchange()).status).toBe(401);
  const appHeaders = {
    cookie: `${cookie}; application=ok; puddle_proxy=legacy`,
    origin: proxyOrigin,
    authorization: 'Basic application-auth',
    'x-puddle-resource': 'forged',
    'x-puddle-application-authorization': 'forged',
  };
  const app = await fetch(`${proxyOrigin}${prefix}check?puddle_token=legacy&keep=ok`, {
    headers: appHeaders,
  });
  expect(app.status).toBe(200);
  expect(app.headers.get('set-cookie')).toContain('application=kept');
  const seen = (await app.json()) as { url: string; headers: Record<string, string> };
  expect(seen.url).toBe('/check?keep=ok');
  expect(seen.headers.authorization).toBe('Basic application-auth');
  expect(seen.headers.cookie).toBe('application=ok');
  expect(JSON.stringify(seen)).not.toContain('puddle');
  expect(
    (await fetch(`${proxyOrigin}/proxy/${session.id}/${port + 1}/`, { headers: appHeaders }))
      .status,
  ).toBe(401);
  expect(
    (await fetch(`${proxyOrigin}${prefix}`, { headers: { ...appHeaders, origin: f.origin } }))
      .status,
  ).toBe(403);
  const recovered = await fetch(`${proxyOrigin}/assets/test.js`, {
    headers: { referer: `${proxyOrigin}${prefix}app` },
    redirect: 'manual',
  });
  expect(recovered.status).toBe(307);
  expect(recovered.headers.get('location')).toBe(`${prefix}assets/test.js`);
  const proxy = new WebSocket(`${proxyOrigin.replace('http:', 'ws:')}${prefix}socket`, {
    origin: proxyOrigin,
    headers: { cookie },
  });
  const messages: string[] = [];
  proxy.on('message', (raw) => messages.push(String(raw)));
  const stream = await fetch(`${proxyOrigin}${prefix}stream`, {
    headers: { origin: proxyOrigin, cookie },
  });
  expect(stream.status).toBe(200);
  let chunks = 0;
  let ended = false;
  const reader = stream.body!.getReader();
  const consuming = (async () => {
    try {
      while (!(await reader.read()).done) chunks++;
    } catch {
      /* revoked */
    } finally {
      ended = true;
    }
  })();
  try {
    await until(
      () => messages.length,
      (length) => length > 0,
    );
    expect(messages[0]).not.toContain('puddle');
    // Beyond the initial token's absolute 60-second lifetime: streams must
    // survive through their own authenticated resource renewals.
    await sleep(62_000);
    expect(ended).toBe(false);
    expect(chunks).toBeGreaterThan(100);
    proxy.send('after-rotation');
    await until(() => messages.includes('after-rotation'), Boolean);
    terminal.send({ t: 'stdin', session: session.id, term: 'agent', data: 'after-rotation\n' });
    await until(
      () =>
        terminal.messages.some((m) => m.t === 'output' && m.data.includes('INPUT:after-rotation')),
      Boolean,
    );
    const closed = new Promise((resolve) => proxy.once('close', resolve));
    expect((await f.req('/cockpit/logout', { method: 'POST' })).status).toBe(200);
    await closed;
    await consuming;
    expect((await fetch(`${proxyOrigin}${prefix}`, { headers: { cookie } })).status).toBe(401);
  } finally {
    proxy.terminate();
    terminal.close();
    await reader.cancel().catch(() => {});
  }
}, 90_000);
