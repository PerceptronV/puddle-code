import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
// Build the daemon first. This runs only isolated HTTP middleware, never puddled.
import { compressJson } from '../../../daemon/dist/http/compression.js';
import { revalidateJson } from '../../../daemon/dist/http/revalidation.js';

const require = createRequire(new URL('../../../daemon/package.json', import.meta.url));
const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const app = new Hono();
const requests = [];
let content = 'unchanged source line\n'.repeat(4000);
let allowed = true;
app.use('/api/*', async (c, next) => {
  if (!allowed || c.req.header('authorization') !== 'Bearer fixture') return c.json({}, 401);
  await next();
  if (c.req.method === 'GET')
    requests.push({ status: c.res.status, tag: c.req.header('if-none-match') });
});
app.use('/api/*', compressJson);
app.use('/api/*', revalidateJson);
app.get('/', (c) => c.html('<!doctype html><title>Isolated HTTP cache check</title>'));
app.get('/api/file', (c) => c.json({ content }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const read = () =>
    page.evaluate(async () => {
      const response = await fetch('/api/file', { headers: { authorization: 'Bearer fixture' } });
      return { status: response.status, body: await response.json() };
    });
  const first = await read();
  const second = await read();
  assert.deepEqual(second, first);
  assert.equal(second.status, 200); // Browser reconstructs the cached body after wire-level 304.
  assert.deepEqual(
    requests.map((request) => request.status),
    [200, 304],
  );
  assert.ok(requests[1].tag);
  content = 'changed on host';
  assert.equal((await read()).body.content, content);
  assert.deepEqual(
    requests.map((request) => request.status),
    [200, 304, 200],
  );
  allowed = false;
  assert.equal((await read()).status, 401);
  console.log(
    'Browser revalidation: 200 → 304 → changed 200; exact cached JSON restored, revoked authority rejected.',
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
