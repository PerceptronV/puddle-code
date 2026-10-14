import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { CompilationRunResponse, CompilationStatusResponse } from '@puddle/shared';

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

function result(revision: number): CompilationRunResponse {
  return {
    provider: 'latex',
    executor: 'latexmk',
    revision,
    source: { session: 'session', path: 'document.tex', root: '/project' },
    artifacts: [
      {
        role: 'preview',
        media_type: 'application/pdf',
        file: { session: 'session', path: 'document.pdf', root: '/project/output' },
      },
    ],
  };
}

for (const registeringDuringBuild of [false, true]) {
  test(`refreshes completed PDF revisions when ${registeringDuringBuild ? 'registration' : 'polling'} sees an unfinished build`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let snapshot: CompilationStatusResponse = {
      provider: 'latex',
      mode: 'eager',
      state: registeringDuringBuild ? 'running' : 'succeeded',
      revision: registeringDuringBuild ? 2 : 1,
      result: result(1),
      error: null,
    };
    let pdfPages = 1;
    let mediaRequests = 0;
    await page.route(`${origin}/api/compilation/**`, (route) => route.fulfill({ json: snapshot }));
    await page.route(`${origin}/api/worktrees/session/media?*`, (route) => {
      mediaRequests += 1;
      return route.fulfill({ contentType: 'application/pdf', body: documentPdf(pdfPages) });
    });
    await page.goto(`${origin}/e2e/fixtures/compilation-refresh.html`);
    const revisions = page.getByLabel('Delivered revisions');
    const state = page.getByLabel('Compilation state');
    const pages = page.locator('[data-pdf-page][data-scroll-ready="true"]');
    await expect(revisions).toHaveText('1');
    await expect(pages).toHaveCount(1);
    expect(mediaRequests).toBe(1);

    // A new run still exposes the previous successful result and stable PDF.
    snapshot = { ...snapshot, state: 'running', revision: 2 };
    await expect(state).toHaveText('running');
    await expect(revisions).toHaveText('1');
    expect(mediaRequests).toBe(1);

    // Promotion precedes success. The same status revision now carries new bytes.
    pdfPages = 2;
    snapshot = { ...snapshot, state: 'succeeded', result: result(2) };
    await expect(state).toHaveText('settled');
    await expect(revisions).toHaveText('1,2');
    await expect(pages).toHaveCount(2);
    expect(mediaRequests).toBe(2);

    // A failed later run retains the last good preview without refreshing it.
    snapshot = {
      ...snapshot,
      state: 'failed',
      revision: 3,
      error: { message: 'Source contains an error' },
    };
    await expect(page.getByLabel('Compilation error')).toHaveText('Source contains an error');
    await expect(revisions).toHaveText('1,2');
    expect(mediaRequests).toBe(2);

    // Polling may miss a success before the next dirty run starts. Deliver that
    // completed result once, then still deliver the follow-up at the same revision.
    pdfPages = 3;
    snapshot = { ...snapshot, state: 'running', revision: 5, result: result(4), error: null };
    await expect(state).toHaveText('running');
    await expect(revisions).toHaveText('1,2,4');
    await expect(pages).toHaveCount(3);
    pdfPages = 4;
    snapshot = { ...snapshot, state: 'succeeded', result: result(5) };
    await expect(state).toHaveText('settled');
    await expect(revisions).toHaveText('1,2,4,5');
    await expect(pages).toHaveCount(4);
    expect(mediaRequests).toBe(4);
    expect(errors).toEqual([]);
  });
}

/** Valid PDFs with visibly different page counts exercise the actual viewer and worker. */
function documentPdf(pages: number): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${pages} >>`,
    ...Array.from(
      { length: pages },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << >> /Contents ${pages + 3} 0 R >>`,
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
