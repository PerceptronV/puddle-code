import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RELEASE_NOTES_MAX_BYTES } from '@puddle/shared';
import { installedReleaseNotes } from '../../../src/host/releases/notes.js';
import { buildApp } from '../../../src/http/app.js';
import { LeaseRegistry } from '../../../src/security/leases.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-release-notes-'));
  homes.push(home);
  return home;
}

it('keeps running daemon notes distinct from the currently selected runtime release', () => {
  const home = fixture();
  const first = runtimeRelease(home, '0.4.0');
  writeFileSync(join(first.release, 'RELEASE_NOTES.md'), '# Runtime one\n');
  first.select();
  expect(installedReleaseNotes(home, '0.4.1', '# Running daemon\n')).toEqual({
    releases: [
      { component: 'daemon', version: '0.4.1', markdown: '# Running daemon\n' },
      { component: 'runtime', version: '0.4.0', markdown: '# Runtime one\n' },
    ],
  });
  const second = runtimeRelease(home, '0.4.2');
  writeFileSync(join(second.release, 'RELEASE_NOTES.md'), '# Runtime two\n');
  second.select();
  expect(installedReleaseNotes(home, '0.4.1', '# Running daemon\n').releases[1]).toEqual({
    component: 'runtime',
    version: '0.4.2',
    markdown: '# Runtime two\n',
  });
});

it('omits unavailable legacy notes without borrowing the running release content', () => {
  const home = fixture();
  runtimeRelease(home, '0.3.14').select();
  expect(installedReleaseNotes(home, '0.4.0', '# Current\n')).toEqual({
    releases: [{ component: 'daemon', version: '0.4.0', markdown: '# Current\n' }],
  });
  expect(installedReleaseNotes(undefined, '0.4.0', null)).toEqual({ releases: [] });
});

it.each(['symlink', 'directory', 'oversized'] as const)(
  'omits %s runtime notes without reading unbounded or external content',
  (kind) => {
    const home = fixture();
    const release = runtimeRelease(home);
    release.select();
    const notes = join(release.release, 'RELEASE_NOTES.md');
    if (kind === 'symlink') {
      const outside = join(home, 'private-notes');
      writeFileSync(outside, 'must not be disclosed');
      symlinkSync(outside, notes);
    } else if (kind === 'directory') mkdirSync(notes);
    else writeFileSync(notes, 'x'.repeat(RELEASE_NOTES_MAX_BYTES + 1));
    expect(installedReleaseNotes(home, '0.4.0', null)).toEqual({ releases: [] });
  },
);

it('keeps the new route behind bearer and Origin checks and read-only', async () => {
  const authority = new LeaseRegistry();
  try {
    const lease = authority.create();
    const app = buildApp({ version: '0.4.0', authority });
    expect(
      (await app.request('/api/release-notes', { headers: { host: 'localhost' } })).status,
    ).toBe(401);
    const headers = { host: 'localhost', authorization: `Bearer ${lease.token}` };
    const response = await app.request('/api/release-notes', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ releases: [] });
    expect((await app.request('/api/release-notes', { method: 'POST', headers })).status).toBe(404);
    expect(
      (
        await app.request('/api/release-notes', {
          headers: { ...headers, origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403);
  } finally {
    authority.dispose();
  }
});
