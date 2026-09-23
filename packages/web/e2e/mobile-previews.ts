import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { mobileFixture } from './mobile-fixture';

export async function checkMobilePreviews(
  page: Page,
  fixture: Awaited<ReturnType<typeof mobileFixture>>,
  testInfo: TestInfo,
) {
  // The preview shell's HTTP sandbox also protects a direct navigation.
  const shell = await page.context().newPage();
  try {
    await shell.goto(fixture.appOrigin + '/preview.html');
    expect(
      await shell.evaluate(() => {
        try {
          return localStorage.length >= 0;
        } catch {
          return false;
        }
      }),
    ).toBe(false);
  } finally {
    await shell.close();
  }
  const root = fixture.session.worktree_path!;
  const directory = join(root, 'previews');
  mkdirSync(directory);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(join(directory, 'pixel.png'), png);
  writeFileSync(join(directory, 'page.css'), 'h1 { font-style: italic; }');
  writeFileSync(
    join(directory, 'page.js'),
    'document.querySelector("h1").textContent = "Script loaded";',
  );
  const html = `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="page.css"></head><body>
    <h1>Waiting for script</h1><img src="pixel.png" alt="Local image"><p>$x^2$</p>
    <button onclick="this.textContent = 'Clicked'">Run JavaScript</button>
    <script src="page.js"></script><script>
      window.repositoryExecuted = true;
      for (const [name, read] of [
        ['parent', () => parent.document.body],
        ['storage', () => localStorage.length],
        ['cookie', () => document.cookie],
      ]) {
        try { read(); document.body.dataset[name] = 'accessible'; }
        catch { document.body.dataset[name] = 'blocked'; }
      }
    </script></body></html>`;
  writeFileSync(join(directory, 'page.html'), html);
  writeFileSync(
    join(directory, 'guide.md'),
    `# Preview guide

Maths: $x^2$

\`\`\`mermaid
graph LR
  A --> B
\`\`\`

[Interactive page](page.html)

${Array.from({ length: 12 }, (_, i) => `![Local image ${i}](pixel.png)`).join('\n\n')}
`,
  );
  const browse = page.getByRole('button', { name: 'Open file or directory', exact: true });
  const openPath = async (path: string) => {
    await browse.click();
    await page.getByRole('textbox', { name: 'File or directory path', exact: true }).fill(path);
    await page.getByRole('button', { name: 'Open path', exact: true }).click();
  };
  const toggle = page.getByRole('button', { name: 'Preview file', exact: true });
  await openPath(join(directory, 'guide.md'));
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.phone-file-source')).toContainText('# Preview guide');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Preview guide', exact: true })).toBeVisible();
  await expect(page.locator('.md-preview .katex')).toHaveCount(1);
  await expect(page.locator('.md-preview svg')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.md-preview img')
        .evaluateAll(
          (images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length,
        ),
    )
    .toBe(12);
  await page.screenshot({ path: testInfo.outputPath('phone-markdown-preview.png') });
  await page.getByRole('link', { name: 'Interactive page', exact: true }).click();
  const frame = page.frameLocator('.phone-files iframe');
  await expect(frame.getByRole('heading', { name: 'Script loaded', exact: true })).toBeVisible();
  await expect(frame.locator('h1')).toHaveCSS('font-style', 'italic');
  await expect(frame.locator('.katex')).toHaveCount(1);
  await expect
    .poll(() => frame.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(1);
  for (const name of ['parent', 'storage', 'cookie'])
    await expect(frame.locator('body')).toHaveAttribute(`data-${name}`, 'blocked');
  await frame.getByRole('button', { name: 'Run JavaScript', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Clicked', exact: true })).toBeVisible();
  expect(await page.evaluate(() => 'repositoryExecuted' in window)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('phone-html-preview.png') });
  await toggle.click();
  await expect(page.locator('.phone-file-source')).toContainText(
    'window.repositoryExecuted = true',
  );
  await expect(page.locator('iframe')).toHaveCount(0);
  await toggle.click();
  await expect(frame.getByRole('heading', { name: 'Script loaded', exact: true })).toBeVisible();
  writeFileSync(
    join(directory, 'page.js'),
    'document.querySelector("h1").textContent = "Refreshed script";',
  );
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Refreshed script', exact: true })).toBeVisible();

  await openPath(join(directory, 'pixel.png'));
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect
    .poll(() =>
      page
        .locator('.phone-files img[alt$="pixel.png"]')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(1);

  // Asset resolution remains relative to a custom host root, including scripts.
  const outside = join(fixture.local.home, 'preview-outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'page.html'), html);
  writeFileSync(
    join(outside, 'page.js'),
    'document.querySelector("h1").textContent = "Outside preview";',
  );
  writeFileSync(join(outside, 'page.css'), 'h1 { font-style: italic; }');
  writeFileSync(join(outside, 'pixel.png'), png);
  await openPath(join(outside, 'page.html'));
  await toggle.click();
  await expect(frame.getByRole('heading', { name: 'Outside preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to files', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select file page.html', exact: true }),
  ).toBeVisible();

  await openPath(join(root, 'review.html'));
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Back to files', exact: true }).click();
}
