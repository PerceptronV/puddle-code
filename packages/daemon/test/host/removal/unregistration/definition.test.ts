import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { removeReviewedServiceDefinition } from '../../../../src/host/removal/unregistration/definition.js';
import { removalInstallationFixture as fixture } from '../../../helpers/removal-service.js';

it('deletes the reviewed bytes in an owned 0755 service directory', async () => {
  const f = fixture();
  try {
    const review = await f.review();
    chmodSync(dirname(f.file), 0o755);
    let checked = false;
    removeReviewedServiceDefinition(review, () => {
      checked = true;
    });
    expect(checked).toBe(true);
    expect(existsSync(f.file)).toBe(false);
    expect(existsSync(f.release)).toBe(true);
  } finally {
    f.close();
  }
});

it.each([
  'bytes',
  'size',
  'hard-link',
  'symbolic-link',
  'file-mode',
  'directory-mode',
  'authority',
])('preserves the service file after changed %s evidence', async (change) => {
  const f = fixture();
  try {
    const review = await f.review();
    const neighbour = `${f.file}.neighbour`;
    writeFileSync(neighbour, 'neighbour', { mode: 0o600 });
    if (change === 'bytes') writeFileSync(f.file, 'changed source');
    if (change === 'size') writeFileSync(f.file, Buffer.alloc(64 * 1024 + 1));
    if (change === 'hard-link') linkSync(f.file, `${f.file}.link`);
    if (change === 'symbolic-link') {
      unlinkSync(f.file);
      symlinkSync(neighbour, f.file);
    }
    if (change === 'file-mode') chmodSync(f.file, 0o666);
    if (change === 'directory-mode') chmodSync(dirname(f.file), 0o777);
    const bytes = readFileSync(f.file);
    expect(() =>
      removeReviewedServiceDefinition(review, () => {
        if (change === 'authority') throw new Error('Authority expired');
      }),
    ).toThrow();
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(readFileSync(neighbour, 'utf8')).toBe('neighbour');
  } finally {
    f.close();
  }
});
