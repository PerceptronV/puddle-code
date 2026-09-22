import { expect, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { mobileFixture } from './mobile-fixture';
import { holdAndDrag } from './mobile-selection';

export async function checkMobilePaths(
  page: Page,
  fixture: Awaited<ReturnType<typeof mobileFixture>>,
  testInfo: TestInfo,
) {
  const root = fixture.session.worktree_path!;
  const directory = join(root, 'nested');
  const path = join(directory, 'notes.txt');
  mkdirSync(directory);
  writeFileSync(path, 'Selectable file text 日本語\nA second line to copy.\n');
  const outside = join(fixture.local.home, 'outside.txt');
  writeFileSync(outside, 'Outside the project');
  writeFileSync(join(fixture.local.home, 'sibling.txt'), 'A sibling file');
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await page.getByRole('button', { name: 'Open folder nested', exact: true }).click();
  const browse = page.getByRole('button', { name: 'Open file or directory', exact: true });
  const input = page.getByRole('textbox', { name: 'File or directory path', exact: true });
  const open = page.getByRole('button', { name: 'Open path', exact: true });
  await browse.click();
  await expect(input).toHaveValue(directory);
  await open.click();
  await page.getByRole('button', { name: 'Select file notes.txt', exact: true }).dblclick();
  await browse.click();
  await expect(input).toHaveValue(path);
  await input.fill(join(directory, 'missing.txt'));
  await open.click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await input.fill(path);
  await open.click();
  const source = page.locator('.phone-file-source');
  await expect(source).toContainText('Selectable file text 日本語');
  expect(await source.evaluate((element) => getComputedStyle(element).userSelect)).toBe('text');
  const lineHeight = await source.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  );
  await holdAndDrag(page, source, { x: 18, y: lineHeight / 2 }, { x: 155, y: lineHeight * 1.5 });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain('file');
  await expect(page.getByRole('button', { name: 'Expand sessions', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('phone-file-selection.png') });
  await page
    .getByRole('toolbar', { name: 'Selected file text' })
    .getByRole('button', { name: 'Copy', exact: true })
    .tap();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('file');
  await expect(page.getByRole('toolbar', { name: 'Selected file text' })).toHaveCount(0);
  await browse.click();
  await input.fill(outside);
  await open.click();
  await expect(source).toHaveText('Outside the project');
  await browse.click();
  await expect(input).toHaveValue(outside);
  // Relative input resolves against the currently browsed host directory.
  await input.fill('sibling.txt');
  await open.click();
  await expect(source).toHaveText('A sibling file');
  await page.getByRole('button', { name: 'Back to files', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select file outside.txt', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to worktree', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open folder nested', exact: true })).toBeVisible();
}
