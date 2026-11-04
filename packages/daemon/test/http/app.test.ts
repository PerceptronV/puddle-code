import { LeaseRegistry } from '../../src/security/leases.js';
import { describe, expect, it, vi } from 'vitest';
import { versionResponseSchema } from '@puddle/shared';
import { buildApp } from '../../src/http/app.js';
import { HostAdmission } from '../../src/host/lifecycle/admission.js';

const authority = new LeaseRegistry();
const TOKEN = authority.create().token;

function app() {
  return buildApp({ version: '0.0.1', authority });
}

function get(path: string, headers: Record<string, string> = {}) {
  return app().request(path, { headers: { host: 'localhost:7434', ...headers } });
}

describe('GET /api/version', () => {
  it('returns the daemon version with a valid token', async () => {
    const res = await get('/api/version', { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
    expect(versionResponseSchema.parse(await res.json()).version).toBe('0.0.1');
  });
});

describe('local security middleware', () => {
  it('rejects /api requests without a token', async () => {
    const res = await get('/api/version');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_expired');
  });

  it('rejects a wrong token of the same length', async () => {
    const res = await get('/api/version', { authorization: `Bearer ${'x'.repeat(64)}` });
    expect(res.status).toBe(401);
  });

  it('rejects a non-local Host (DNS rebinding)', async () => {
    const res = await app().request('/api/version', {
      headers: { host: 'evil.example.com:7433', authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a foreign Origin but accepts a local one on any port', async () => {
    const bad = await get('/api/version', {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://evil.example.com',
    });
    expect(bad.status).toBe(403);
    const tunnelled = await get('/api/version', {
      authorization: `Bearer ${TOKEN}`,
      origin: 'http://localhost:9182',
    });
    expect(tunnelled.status).toBe(200);
  });
});

describe('headless API (Phase 6: the CLI serves the UI)', () => {
  it('404s unmatched non-API routes', async () => {
    const res = await app().request('/', { headers: { host: 'localhost:7434' } });
    expect(res.status).toBe(404);
  });
});

describe('host request admission', () => {
  it('retains authentication and version inspection while pausing API handlers', async () => {
    const admission = new HostAdmission();
    const api = buildApp({ version: '0.4.0', authority, admission });
    const called = vi.fn();
    api.post('/api/test', (c) => {
      called();
      return c.body(null, 204);
    });
    const headers = { host: 'localhost:7434', authorization: `Bearer ${TOKEN}` };
    const hold = admission.pause();
    const unauthorised = await api.request('/api/test', {
      method: 'POST',
      headers: { host: headers.host },
    });
    expect(unauthorised.status).toBe(401);
    expect((await api.request('/api/version', { headers })).status).toBe(200);
    const blocked = await api.request('/api/test', { method: 'POST', headers });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: { code: 'host_maintenance' } });
    expect(called).not.toHaveBeenCalled();
    hold.release();
    expect((await api.request('/api/test', { method: 'POST', headers })).status).toBe(204);
    expect(called).toHaveBeenCalledOnce();
  });

  it('keeps an admitted asynchronous handler inside the drain until it settles', async () => {
    const admission = new HostAdmission();
    const api = buildApp({ version: '0.4.0', authority, admission });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    api.post('/api/test', async (c) => {
      enter();
      await finished;
      return c.body(null, 204);
    });
    const request = api.request('/api/test', {
      method: 'POST',
      headers: { host: 'localhost:7434', authorization: `Bearer ${TOKEN}` },
    });
    await entered;
    admission.close();
    const drained = vi.fn();
    const drain = admission.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    finish();
    expect((await request).status).toBe(204);
    await drain;
    expect(drained).toHaveBeenCalledOnce();
  });
});
