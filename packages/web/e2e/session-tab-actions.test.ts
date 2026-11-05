import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

test.use({ viewport: { width: 1100, height: 800 } });
let server: ViteDevServer;
let origin: string;
const sessionIds = [1, 2, 3].map((id) => `20000000-0000-4000-8000-00000000000${id}`);

test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: fileURLToPath(new URL('../vite.build.config.ts', import.meta.url)),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => server?.close());

for (const concurrent of [false, true]) {
  test(`archives hovered tabs once, with overlapping requests: ${concurrent}`, async ({ page }) => {
    const requests: import('@playwright/test').Route[] = [];
    const archived = new Set<string>();
    await page.route(`${origin}/api/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/archive')) {
        requests.push(route);
        return;
      }
      const data = await page.evaluate(() => window.notificationFixture.data());
      const sessions = data.sessions.map((session) =>
        archived.has(session.id) ? { ...session, status: 'archived' } : session,
      );
      if (path === '/api/sessions') return route.fulfill({ json: sessions });
      if (path === '/api/projects') return route.fulfill({ json: data.projects });
      if (path.startsWith('/api/projects/')) {
        const project = data.projects.find((project) => path.endsWith(project.id));
        if (project)
          return route.fulfill({
            json: {
              project,
              sessions: sessions.filter((session) => session.project_id === project.id),
            },
          });
      }
      if (path === '/api/accounts') return route.fulfill({ json: [] });
      if (path.endsWith('/file'))
        return route.fulfill({
          json: { path: 'notes.md', content: '# Notes', binary: false, size: 7, mtime_ms: 1 },
        });
      if (path.endsWith('/ports')) return route.fulfill({ json: { ports: [] } });
      if (path.endsWith('/env')) return route.fulfill({ json: { entries: [] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(`${origin}/e2e/fixtures/desktop-notifications.html?workspace&stopped`);
    const tab = (index: number) =>
      page
        .locator('[aria-roledescription="draggable"]')
        .filter({ hasText: `Conversation ${index + 1}` });
    await tab(1).hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await tab(1).getByRole('button', { name: 'Archive session', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    if (concurrent) {
      await tab(0).hover();
      await tab(0).getByRole('button', { name: 'Archive session', exact: true }).click();
      await expect.poll(() => requests.length).toBe(2);
    }
    for (const [index, request] of requests.entries()) {
      const sessionId = sessionIds[index === 0 ? 1 : 0]!;
      archived.add(sessionId);
      const data = await page.evaluate(() => window.notificationFixture.data());
      await request.fulfill({
        json: { ...data.sessions.find((session) => session.id === sessionId), status: 'archived' },
      });
      await expect(tab(index === 0 ? 1 : 0)).toHaveCount(0);
    }
    await expect(tab(1)).toHaveCount(0);
    if (concurrent) await expect(tab(0)).toHaveCount(0);
  });
}
