import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { compressJson } from '../../src/http/compression.js';
import { revalidateJson } from '../../src/http/revalidation.js';
import { LeaseRegistry } from '../../src/security/leases.js';

describe('private JSON revalidation', () => {
  it('validates current content after authority, preserves mutations and rejects revoked readers', async () => {
    const authority = new LeaseRegistry();
    try {
      const app = buildApp({ version: 'test', authority });
      let value = 'before';
      const padding = 'fixture'.repeat(1024);
      let reads = 0;
      app.get('/api/example', (c) => {
        reads++;
        return c.json({ value, padding });
      });
      app.post('/api/example', (c) => {
        value = 'after';
        return c.json({ value });
      });
      const lease = authority.create();
      const headers = {
        host: 'localhost:7434',
        authorization: `Bearer ${lease.token}`,
      };
      const first = await app.request('/api/example', { headers });
      const tag = first.headers.get('etag')!;
      expect(tag).toMatch(/^W\//);
      expect(first.headers.get('cache-control')).toBe('private, no-cache');
      expect(first.headers.get('vary')).toContain('Authorization');
      expect(await first.json()).toEqual({ value: 'before', padding });
      for (const match of [tag, tag.slice(2), `"unrelated", ${tag}`]) {
        const next = await app.request('/api/example', {
          headers: { ...headers, 'if-none-match': match },
        });
        expect(next.status).toBe(304);
        expect(await next.text()).toBe('');
      }
      expect(reads).toBe(4);
      const mutation = await app.request('/api/example', { method: 'POST', headers });
      expect(mutation.headers.has('etag')).toBe(false);
      const changed = await app.request('/api/example', {
        headers: { ...headers, 'if-none-match': tag },
      });
      expect(changed.status).toBe(200);
      expect(changed.headers.get('etag')).not.toBe(tag);
      expect(await changed.json()).toEqual({ value: 'after', padding });
      authority.revoke(lease.generation);
      const rejected = await app.request('/api/example', {
        headers: { ...headers, 'if-none-match': tag },
      });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.has('etag')).toBe(false);
      expect(reads).toBe(5);
    } finally {
      authority.dispose();
    }
  });

  it('shares a weak validator across gzip and identity without compressing a 304', async () => {
    const app = new Hono();
    app.use('*', compressJson);
    app.use('*', revalidateJson);
    const payload = { content: 'unchanged source line\n'.repeat(4000) };
    app.get('/', (c) => c.json(payload));
    const first = await app.request('/', { headers: { 'accept-encoding': 'gzip' } });
    const tag = first.headers.get('etag')!;
    expect(JSON.parse(gunzipSync(Buffer.from(await first.arrayBuffer())).toString())).toEqual(
      payload,
    );
    const second = await app.request('/', {
      headers: { 'accept-encoding': 'gzip', 'if-none-match': tag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.has('content-encoding')).toBe(false);
    expect(second.headers.has('content-length')).toBe(false);
    const identity = await app.request('/');
    expect(identity.headers.get('etag')).toBe(tag);
    expect(await identity.json()).toEqual(payload);
  });

  it('respects explicit cache policy, files, errors and existing validators', async () => {
    const app = new Hono();
    app.use('*', revalidateJson);
    app.get('/private', (c) => c.json({ secret: true }, 200, { 'cache-control': 'no-store' }));
    app.get('/file', (c) => c.text('unchanged file'));
    app.get('/error', (c) => c.json({ error: 'denied' }, 403));
    app.get('/tiny', (c) => c.json({ status: 'running' }));
    app.get('/validator', (c) => c.json({ value: 1 }, 200, { etag: '"owned"' }));
    for (const path of ['/private', '/file', '/error', '/tiny']) {
      const response = await app.request(path, { headers: { 'if-none-match': '*' } });
      expect(response.status).not.toBe(304);
      expect(response.headers.has('etag')).toBe(false);
    }
    expect((await app.request('/private')).headers.get('cache-control')).toBe('no-store');
    const owned = await app.request('/validator');
    expect(owned.headers.get('etag')).toBe('"owned"');
    expect(owned.headers.has('cache-control')).toBe(false);
  });

  it('leaves profile projections to the relay without generating unusable validators', async () => {
    const app = new Hono<{ Variables: { remoteProfile: string } }>();
    app.use('*', async (c, next) => {
      c.set('remoteProfile', 'fixture');
      await next();
    });
    app.use('*', revalidateJson);
    app.get('/', (c) => c.json({ content: 'relay'.repeat(2000) }));
    const response = await app.request('/');
    expect(response.headers.has('etag')).toBe(false);
    expect(await response.json()).toEqual({ content: 'relay'.repeat(2000) });
  });

  it('passes large JSON through without retaining an entire stream and propagates cancellation', async () => {
    const app = new Hono();
    app.use('*', revalidateJson);
    let cancelled = false;
    let produced = 0;
    app.get(
      '/',
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              produced++;
              controller.enqueue(new Uint8Array(64 * 1024).fill(32));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const response = await app.request('/');
    expect(produced).toBeLessThanOrEqual(18);
    expect(response.headers.has('etag')).toBe(false);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(new Uint8Array(64 * 1024).fill(32));
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
