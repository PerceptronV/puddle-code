import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { versionResponseSchema } from '@puddle/shared';
import { buildApp } from '../src/http/app.js';

const TOKEN = 't'.repeat(64);

function app(assetsDir: string | null = null) {
  return buildApp({ version: '0.0.1', assetsDir, token: TOKEN });
}

function get(path: string, headers: Record<string, string> = {}) {
  return app().request(path, { headers: { host: 'localhost:7433', ...headers } });
}

function withAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>puddle</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("hi")');
  return dir;
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
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorised');
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

describe('static asset serving (tokenless by design)', () => {
  it('serves index.html at /', async () => {
    const res = await app(withAssets()).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('puddle');
  });

  it('serves hashed assets with the right mime type', async () => {
    const res = await app(withAssets()).request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for SPA routes', async () => {
    const res = await app(withAssets()).request('/project/42');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('puddle');
  });

  it('never escapes the asset root', async () => {
    const res = await app(withAssets()).request('/assets/../../../../etc/passwd');
    expect(res.status).toBe(200); // SPA fallback, not the file
    expect(await res.text()).not.toContain('root:');
  });
});
