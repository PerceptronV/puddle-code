/* global window */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.PREVIEW_URL ?? 'http://localhost:5174/');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTitle('All projects', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const { browserTransport } = await import('/src/lib/transport/browser-transport.ts');
    const transport = browserTransport();
    const request = transport.request.bind(transport);
    window.catalogueRequests = [];
    transport.request = async (method, path, ...args) => {
      window.catalogueRequests.push(path);
      if (path.startsWith('/api/projects/catalogue'))
        await new Promise((resolve) => {
          window.releaseCatalogue = resolve;
        });
      return request(method, path, ...args);
    };
  });
  await page.getByTitle('All projects', { exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseCatalogue === 'function');
  // Navigation remains available while the fresh aggregate response is stalled.
  await page.getByRole('heading', { name: 'puddle', exact: true }).waitFor();
  await page.evaluate(() => window.releaseCatalogue());
  await page.waitForFunction(async () => {
    const { queryClient } = await import('/src/lib/queries/client.ts');
    return queryClient
      .getQueriesData({ queryKey: ['project-catalogue'] })
      .some(([, data]) => data?.counts);
  });
  const requests = await page.evaluate(() => window.catalogueRequests);
  assert.equal(requests.filter((path) => path.startsWith('/api/projects/catalogue')).length, 1);
  assert.equal(requests.filter((path) => path.startsWith('/api/sessions?project=')).length, 0);
  assert.deepEqual(errors, []);
  console.log(
    'Cached project navigation stays visible during a delayed catalogue read; one summary request, no per-card session requests.',
  );
} finally {
  await browser.close();
}
