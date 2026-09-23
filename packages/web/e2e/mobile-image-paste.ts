import { expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_UPLOAD_POLICY, REMOTE_POLICY } from '@puddle/shared';
import { until, websocket } from '../../cli/e2e/helpers';
import type { mobileFixture } from './mobile-fixture';

export async function checkImagePicker(
  page: Page,
  fixture: Awaited<ReturnType<typeof mobileFixture>>,
  testInfo: TestInfo,
) {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
    'base64',
  );
  const button = page.getByRole('button', { name: 'Insert image', exact: true });
  const chooser = page.getByLabel('Choose image', { exact: true });
  await expect(page.getByRole('button', { name: 'Open keyboard' })).toHaveCount(0);
  await expect(button).toBeEnabled();
  const viewer = await websocket(fixture.local.origin, fixture.local.credential);
  const session = fixture.session.id;
  viewer.send({ t: 'attach', session, term: 'agent', cols: 80, rows: 24 });
  await until(() => viewer.messages.some((message) => message.t === 'replay'), Boolean);
  const directory = join(fixture.session.worktree_path!, '.puddle/pastes');
  const files = () => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  };
  const output = () =>
    viewer.messages
      .filter((message) => message.t === 'output')
      .map((message) => ('data' in message ? message.data : ''))
      .join('');
  try {
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep my image caption');
    const opening = page.waitForEvent('filechooser');
    await button.tap();
    await (await opening).setFiles({ name: 'image.png', mimeType: 'image/png', buffer: png });
    await until(files, (names) => names.length === 1);
    await expect(button).toBeEnabled();
    const first = files()[0]!;
    expect(readFileSync(join(directory, first))).toEqual(png);
    expect(output()).not.toContain(`INPUT:.puddle/pastes/${first}`);
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
      'Keep my image caption',
    );
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await until(output, (text) => text.includes(`INPUT:.puddle/pastes/${first} `));
    expect(output().split(`INPUT:.puddle/pastes/${first}`).length - 1).toBe(1);

    // Resetting the input permits selecting the same file a second time.
    await chooser.setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: png });
    await until(files, (names) => names.length === 2);
    await expect(button).toBeEnabled();
    await page.getByRole('button', { name: 'Enter', exact: true }).click();

    // Sources below 4 MiB cross many encrypted requests without changing their bytes.
    const photo = async (width: number, height: number) =>
      Buffer.from(
        await page.evaluate(
          ({ width, height }) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d')!;
            const pixels = context.createImageData(width, height);
            let seed = 123;
            for (let index = 0; index < pixels.data.length; index += 4) {
              seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
              pixels.data[index] = seed & 255;
              pixels.data[index + 1] = (seed >>> 8) & 255;
              pixels.data[index + 2] = (seed >>> 16) & 255;
              pixels.data[index + 3] = 255;
            }
            context.putImageData(pixels, 0, 0);
            return canvas.toDataURL('image/png').split(',')[1]!;
          },
          { width, height },
        ),
        'base64',
      );
    const large = await photo(1200, 900);
    expect(large.length).toBeGreaterThan(REMOTE_POLICY.requestBytes);
    expect(large.length).toBeLessThanOrEqual(IMAGE_UPLOAD_POLICY.imageBytes);
    const before = new Set(files());
    await chooser.setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: large });
    await until(files, (names) => names.length === 3);
    await expect(button).toBeEnabled();
    const preserved = files().find((name) => !before.has(name))!;
    expect(readFileSync(join(directory, preserved)).equals(large)).toBe(true);
    await expect(page.getByText('Image resized for remote access', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await until(output, (text) => text.includes(`INPUT:.puddle/pastes/${preserved} `));

    // Hold the second local chunk read after the first acknowledgement, leaving
    // the real encrypted channel free to exercise terminal input and cancellation.
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      let reads = 0;
      Blob.prototype.arrayBuffer = async function () {
        const bytes = await original.call(this);
        if (this.size === 64 * 1024 && ++reads === 2) {
          Blob.prototype.arrayBuffer = original;
          await new Promise<void>((resolve) => {
            (window as typeof window & { releaseImageChunk?: () => void }).releaseImageChunk =
              resolve;
          });
        }
        return bytes;
      };
    });
    await chooser.setInputFiles({ name: 'cancel.png', mimeType: 'image/png', buffer: large });
    await expect(page.getByRole('progressbar', { name: 'Image upload' })).toHaveAttribute(
      'aria-valuenow',
      /^[1-9]\d*$/,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            typeof (window as typeof window & { releaseImageChunk?: () => void }).releaseImageChunk,
        ),
      )
      .toBe('function');
    await page
      .getByRole('button', { name: 'Cancel image upload', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('phone-image-upload.png') });
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('during-image-upload');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await until(output, (text) => text.includes('INPUT:during-image-upload'));
    await page.getByRole('button', { name: 'Cancel image upload', exact: true }).click();
    await page.evaluate(() =>
      (window as typeof window & { releaseImageChunk?: () => void }).releaseImageChunk?.(),
    );
    await expect(button).toBeEnabled();
    expect(files()).toHaveLength(3);

    // Larger originals are recompressed and can immediately follow a cancelled upload.
    const oversized = await photo(1600, 1200);
    expect(oversized.length).toBeGreaterThan(IMAGE_UPLOAD_POLICY.imageBytes);
    const previous = new Set(files());
    await chooser.setInputFiles({ name: 'resize.png', mimeType: 'image/png', buffer: oversized });
    await until(files, (names) => names.length === 4);
    await expect(button).toBeEnabled();
    const resized = files().find((name) => !previous.has(name))!;
    expect(readFileSync(join(directory, resized)).length).toBeLessThanOrEqual(
      IMAGE_UPLOAD_POLICY.imageBytes,
    );
    await expect(page.getByText('Image resized for remote access', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Connected');
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await until(output, (text) => text.includes(`INPUT:.puddle/pastes/${resized} `));

    await chooser.setInputFiles({
      name: 'unsafe.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await expect(
      page.getByText('Choose a PNG, JPEG, GIF or WebP image.', { exact: true }),
    ).toBeVisible();
    expect(files()).toHaveLength(4);
    await expect(button).toBeEnabled();
    await page.getByRole('textbox', { name: 'Prompt', exact: true }).fill('');
  } finally {
    viewer.close();
  }
}
