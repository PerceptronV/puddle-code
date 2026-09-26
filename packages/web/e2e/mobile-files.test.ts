import { test, expect, type Page } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ hasTouch: true, isMobile: true });
let server: PreviewServer;
let directory: string;
let origin: string;
let requests: string[];
let asset: (path: string) => Promise<{ status: number; body: unknown }>;
const binary = Buffer.from([0, 255, 128, 13, 10, 42]);

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'puddle-mobile-files-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Exercise production chunks and the actual deployed CSP, without a daemon.
  await build({
    root,
    configFile: join(root, 'vite.build.config.ts'),
    logLevel: 'error',
    build: {
      outDir: directory,
      emptyOutDir: true,
      rollupOptions: { input: join(root, 'e2e/fixtures/mobile-files.html') },
    },
  });
  const caddy = await readFile(join(root, '../../deploy/remote/Caddyfile.app'), 'utf8');
  const policy = /Content-Security-Policy "([^"]+)"/
    .exec(caddy)![1]!
    .replace('{$PUDDLE_REMOTE_SERVICE}', 'https://service.example.test')
    .replace('{$PUDDLE_REMOTE_WSS}', 'wss://service.example.test');
  server = await preview({
    root,
    configFile: false,
    build: { outDir: directory },
    preview: { host: '127.0.0.1', port: 0, headers: { 'Content-Security-Policy': policy } },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

// A painted rectangle lets the test distinguish a rendered PDF from an empty canvas.
function documentPdf(): Buffer {
  const stream = '0 0 0 rg 20 20 200 200 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
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

test.beforeEach(async ({ page }) => {
  requests = [];
  asset = async (path) => ({
    status: 200,
    body: {
      mime: path.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
      data: (path.endsWith('.pdf') ? documentPdf() : binary).toString('base64'),
    },
  });
  await page.exposeFunction('readMobileFile', (path: string) => {
    requests.push(path);
    const url = new URL(path, origin);
    if (url.pathname.endsWith('/version'))
      return { status: 200, body: { protocol: { major: 22, minor: 0 } } };
    if (url.pathname.endsWith('/tree'))
      return {
        status: 200,
        body: {
          path: '.',
          entries: [
            { name: 'paper.pdf', type: 'file', size: documentPdf().length },
            { name: 'notes ü.dat', type: 'file', size: binary.length },
            { name: 'large.bin', type: 'file', size: 9 * 1024 * 1024 },
            { name: 'folder', type: 'dir', size: null },
            { name: 'broken-link', type: 'symlink', size: null },
          ],
        },
      };
    if (url.pathname.endsWith('/file'))
      return {
        status: 200,
        body: {
          path: 'paper.pdf',
          binary: true,
          content: null,
          size: documentPdf().length,
          mtime_ms: 1,
        },
      };
    if (url.pathname.endsWith('/preview-asset')) return asset(url.searchParams.get('path')!);
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  await page.goto(`${origin}/e2e/fixtures/mobile-files.html`);
});

test('remote PDFs paint under the deployed security policy', async ({ page }, testInfo) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  await page.getByRole('button', { name: 'Select file paper.pdf' }).dblclick();
  await page.getByRole('button', { name: 'Preview file', exact: true }).click();
  await expect(page.getByLabel('PDF page 1', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.locator('canvas').evaluate((canvas) => {
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        return data.some(
          (value, index) => index % 4 === 3 && value === 255 && data[index - 3] === 0,
        );
      }),
    )
    .toBe(true);
  expect(violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('mobile-pdf-and-switches.png') });
});

test('touch switches retain horizontal tracks and a large tappable area', async ({ page }) => {
  const toggle = page.getByRole('switch', { name: 'Use separate branch' });
  const track = toggle.locator('span').first();
  const bounds = await track.boundingBox();
  expect(bounds!.width).toBeGreaterThan(bounds!.height);
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await toggle.tap();
  await expect(toggle).toBeChecked();
  const thumb = track.locator('span');
  await expect
    .poll(async () => {
      const bounds = (await track.boundingBox())!;
      const dot = (await thumb.boundingBox())!;
      return Math.round(bounds.x + bounds.width - dot.x - dot.width);
    })
    .toBe(2);
  await page.getByText('Use separate branch', { exact: true }).tap();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Disabled switch' })).toBeDisabled();
});

async function holdFile(page: Page, name: string) {
  const row = page.getByRole('button', { name: `Select file ${name}`, exact: true });
  const bounds = (await row.boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: bounds.x + 40, y: bounds.y + bounds.height / 2 }],
  });
  await expect(page.getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  await expect(page.getByRole('button', { name: 'Back to files', exact: true })).toHaveCount(0);
}

for (const name of ['paper.pdf', 'notes ü.dat']) {
  test(`long-press downloads ${name} with its original filename and bytes`, async ({
    page,
  }, testInfo) => {
    await expect(
      page.getByRole('button', { name: `Select file ${name}`, exact: true }),
    ).toBeVisible();
    await holdFile(page, name);
    const saving = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download', exact: true }).tap();
    const download = await saving;
    expect(download.suggestedFilename()).toBe(name);
    const output = testInfo.outputPath(name);
    await download.saveAs(output);
    expect(await readFile(output)).toEqual(name.endsWith('.pdf') ? documentPdf() : binary);
    const request = requests.find((path) => path.includes('/preview-asset?'))!;
    const query = new URL(request, origin).searchParams;
    expect(query.get('path')).toBe(name);
    expect(query.get('root')).toBe('/project');
    expect(requests.some((path) => /\/(media|download)\?/.test(path))).toBe(false);
  });
}

test('scroll movement cancels a hold and unsupported entries have no download menu', async ({
  page,
}) => {
  const row = page.getByRole('button', { name: 'Select file paper.pdf' });
  await row.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    button: 0,
    clientX: 50,
    clientY: 150,
  });
  await row.dispatchEvent('pointermove', { pointerType: 'touch', clientX: 50, clientY: 100 });
  await page.waitForTimeout(800);
  await row.dispatchEvent('pointerup', { pointerType: 'touch' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Open folder folder', exact: true })
    .click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select file broken-link' })).toBeDisabled();
});

test('oversized remote files explain the limit without reading the file', async ({ page }) => {
  await page.getByRole('button', { name: 'Select file large.bin' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Download', exact: true }).tap();
  await expect(
    page.getByText('Downloads must be 8 MiB or smaller.', { exact: true }),
  ).toBeVisible();
  expect(requests.some((path) => path.includes('/preview-asset?'))).toBe(false);
});

test('a completed read cannot download after the host changes', async ({ page }) => {
  let finish!: (response: { status: number; body: unknown }) => void;
  asset = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: 'Select file paper.pdf' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Download', exact: true }).tap();
  await expect.poll(() => !!finish).toBe(true);
  await page.evaluate(() => window.leaveMobileHost());
  finish({
    status: 200,
    body: { mime: 'application/pdf', data: documentPdf().toString('base64') },
  });
  await expect(page.getByText('Downloading paper.pdf…', { exact: true })).toHaveCount(0);
  expect(downloads).toEqual([]);
});
