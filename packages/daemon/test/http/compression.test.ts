import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { compressJson } from '../../src/http/compression.js';
import { buildApp } from '../../src/http/app.js';
import { LeaseRegistry } from '../../src/security/leases.js';

function fixture() {
  const app = new Hono();
  app.use('*', compressJson);
  app.get('/large', (c) => c.json({ text: 'terminal output\n'.repeat(4096) }));
  app.get('/small', (c) => c.json({ status: 'running' }));
  app.get('/stream', (c) =>
    c.body('data: event\n\n', 200, { 'content-type': 'text/event-stream' }),
  );
  app.get('/file', (c) =>
    c.body('raw'.repeat(4096), 200, { 'content-type': 'application/octet-stream' }),
  );
  app.get('/error', (c) => c.json({ error: 'private'.repeat(4096) }, 403));
  app.get('/empty', (c) => c.body(null, 204));
  return app;
}

describe('API compression', () => {
  it('runs behind authority checks and does not make unauthorised responses cacheable', async () => {
    const authority = new LeaseRegistry();
    try {
      const app = buildApp({ version: 'test', authority });
      app.get('/api/test-json', (c) => c.json({ data: 'a'.repeat(2048) }));
      const headers = { host: 'localhost:7434', 'accept-encoding': 'gzip' };
      const rejected = await app.request('/api/test-json', { headers });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.has('content-encoding')).toBe(false);
      const accepted = await app.request('/api/test-json', {
        headers: {
          ...headers,
          authorization: `Bearer ${authority.create().token}`,
        },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get('content-encoding')).toBe('gzip');
      expect(JSON.parse(gunzipSync(Buffer.from(await accepted.arrayBuffer())).toString())).toEqual({
        data: 'a'.repeat(2048),
      });
    } finally {
      authority.dispose();
    }
  });
  it('reduces JSON wire bytes and restores the exact response', async () => {
    const app = fixture();
    const plain = await (await app.request('/large')).text();
    const response = await app.request('/large', { headers: { 'accept-encoding': 'gzip' } });
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toContain('Accept-Encoding');
    expect(response.headers.has('content-length')).toBe(false);
    expect(gunzipSync(bytes).toString()).toBe(plain);
    expect(bytes.length).toBeLessThan(Buffer.byteLength(plain) / 10);
  });

  it.each(['', 'identity', 'gzip;q=0', '*;q=0'])(
    'honours encoding negotiation: %s',
    async (encoding) => {
      const response = await fixture().request('/large', {
        headers: { 'accept-encoding': encoding },
      });
      expect(response.headers.has('content-encoding')).toBe(false);
      expect(await response.json()).toEqual({ text: 'terminal output\n'.repeat(4096) });
    },
  );

  it.each(['/small', '/stream', '/file', '/error', '/empty'])(
    'leaves %s uncompressed',
    async (path) => {
      const app = fixture();
      const expected = await (await app.request(path)).text();
      const response = await app.request(path, { headers: { 'accept-encoding': 'gzip' } });
      expect(response.headers.has('content-encoding')).toBe(false);
      expect(await response.text()).toBe(expected);
    },
  );

  it('preserves multi-chunk JSON and cancellation', async () => {
    let cancelled = false;
    const app = new Hono();
    app.use('*', compressJson);
    app.get(
      '/',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(' '.repeat(2048)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const response = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });
    await response.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });
});
