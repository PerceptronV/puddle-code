import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';

test.use({ viewport: { width: 1000, height: 800 } });
let server: ViteDevServer;
let origin: string;
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

/** Small, valid PDF with unequal page sizes: exercise actual PDF.js geometry and its worker. */
function documentPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>',
    ...[700, 950, 600, 850].map(
      (height) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 ${height}] /Resources << >> /Contents 7 0 R >>`,
    ),
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

for (const ordinary of [false, true])
  test(`${ordinary ? 'ordinary' : 'LaTeX'} PDF scroll and zoom survive project switches and refreshed output`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/worktrees/session/media?*', (route) =>
      route.fulfill({ contentType: 'application/pdf', body: documentPdf() }),
    );
    await page.goto(`${origin}/e2e/fixtures/view-state.html${ordinary ? '?ordinary' : ''}`);
    const scroller = page.getByRole('region', { name: 'PDF document' });
    await expect(page.locator('[data-scroll-ready="true"]')).toHaveCount(4);
    await expect(page.locator('canvas[title]')).toHaveCount(ordinary ? 0 : 4);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Zoom 125%; reset to fit width' })).toBeVisible();
    await scroller.evaluate((element) => {
      element.scrollTop = 1900;
      element.scrollLeft = 100;
    });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(1900);
    await page.getByRole('button', { name: 'Second project' }).click();
    await expect(page.locator('[data-scroll-ready="true"]')).toHaveCount(4);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    await scroller.evaluate((element) => {
      element.scrollTop = 450;
    });
    await page.getByRole('button', { name: 'First project' }).click();
    await expect(page.getByRole('button', { name: 'Zoom 125%; reset to fit width' })).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(1900);
    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(100);
    await page.getByRole('button', { name: 'Recompile' }).click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(1900);
    await page.getByRole('button', { name: 'Second project' }).click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(450);
    expect(errors).toEqual([]);
  });
