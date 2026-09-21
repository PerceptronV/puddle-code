import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { REMOTE_PROTOCOL_VERSION, remoteServiceInfoSchema } from '@puddle/shared';
import { startRemoteService } from '../src/server.js';
import { githubFixture, cookies } from './helpers/oauth.js';

it('enforces HTTP origins, account routing and live service-session revocation on real sockets', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-relay-'));
  const config = {
    home,
    service: 'https://relay.example.test',
    app: 'https://app.example.test',
    secret: 'isolated-test-secret-long-enough-for-better-auth',
    github: { clientId: 'fixture-client', clientSecret: 'fixture-secret' },
    address: '127.0.0.1',
    port: 0,
  };
  const github = githubFixture();
  const remote = await startRemoteService(config);
  const address = remote.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const http = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  const req = (path: string, body?: object, cookie?: string, origin: string | null = config.app) =>
    new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        http + path,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            host: 'relay.example.test',
            ...(origin === null ? {} : { origin }),
            ...(cookie ? { cookie } : {}),
            'content-type': 'application/json',
          },
        },
        (response) => {
          const parts: Buffer[] = [];
          response.on('data', (part: Buffer) => parts.push(part));
          response.on('end', () => {
            const headers = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2)
              headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
            resolve(new Response(Buffer.concat(parts), { status: response.statusCode!, headers }));
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body ? JSON.stringify(body) : undefined);
    });
  const login = async (email: string) => {
    const start = await req('/api/auth/sign-in/social', {
      provider: 'github',
      callbackURL: config.app,
    });
    expect(start.status).toBe(200);
    expect(start.headers.get('access-control-allow-origin')).toBe(config.app);
    const { url } = (await start.json()) as { url: string };
    const callback = new URL(github.callback(url, { email }));
    const response = await req(
      callback.pathname + callback.search,
      undefined,
      cookies(start),
      null,
    );
    expect(response.status).toBe(302);
    return cookies(response);
  };
  const socket = (path: string, headers: Record<string, string>) => {
    const ws = new WebSocket(http.replace('http:', 'ws:') + path, {
      headers: { host: 'relay.example.test', ...headers },
    });
    sockets.push(ws);
    ws.on('error', () => {});
    return ws;
  };
  try {
    const discovery = await (await req('/remote/config')).json();
    expect(discovery).toEqual({ providers: ['github'], protocol: REMOTE_PROTOCOL_VERSION });
    expect(remoteServiceInfoSchema.parse(discovery)).toEqual(discovery);
    expect((await req('/remote/hosts', { label: 'Host' }, undefined, null)).status).toBe(403);
    expect(
      (await req('/remote/hosts', { label: 'Host' }, undefined, 'https://foreign.example.test'))
        .status,
    ).toBe(403);
    const cookie = await login('owner@example.test');
    const other = await login('other@another.test');
    const registered = await req('/remote/hosts', { label: 'Host' }, cookie);
    const { code, host } = (await registered.json()) as { code: string; host: string };
    expect(await (await req('/remote/hosts', undefined, other)).json()).toEqual([]);
    const redeemed = await req('/remote/register', { code }, undefined, null);
    const { credential } = (await redeemed.json()) as { credential: string };
    expect((await req('/remote/register', { code }, undefined, null)).status).toBe(403);
    const connector = socket('/remote/connector', { authorization: `Bearer ${credential}` });
    await once(connector, 'message');
    for (const origin of ['null', 'https://foreign.example.test', '']) {
      const rejected = socket('/remote/browser', { cookie, ...(origin ? { origin } : {}) });
      const closed = new Promise<void>((resolve) => rejected.once('close', () => resolve()));
      await closed;
      expect(rejected.readyState).toBe(WebSocket.CLOSED);
    }
    const foreign = socket('/remote/browser', { cookie: other, origin: config.app });
    await once(foreign, 'open');
    const foreignClosed = once(foreign, 'close');
    foreign.send(JSON.stringify({ t: 'connect', host }));
    await foreignClosed;
    const browser = socket('/remote/browser', { cookie, origin: config.app });
    await once(browser, 'open');
    const opening = once(connector, 'message');
    browser.send(JSON.stringify({ t: 'connect', host }));
    const [{ connection }] = (await opening).map(
      (raw) => JSON.parse(String(raw)) as { connection: string },
    );
    const ready = once(browser, 'message');
    const pipe = socket('/remote/pipe', {
      authorization: `Bearer ${credential}`,
      'x-puddle-pipe': connection!,
    });
    await once(pipe, 'open');
    await ready;
    const forwarded = once(pipe, 'message');
    const bytes = crypto.getRandomValues(new Uint8Array(256));
    browser.send(bytes);
    expect(Buffer.from((await forwarded)[0])).toEqual(Buffer.from(bytes));
    const closed = once(browser, 'close');
    expect((await req('/api/auth/sign-out', {}, cookie)).status).toBe(200);
    await remote.relay.recheck();
    await closed;
    expect(remote.relay.online(host)).toBe(true);
  } finally {
    github.close();
    for (const socket of sockets) socket.terminate();
    await remote.close();
    rmSync(home, { recursive: true, force: true });
  }
});
