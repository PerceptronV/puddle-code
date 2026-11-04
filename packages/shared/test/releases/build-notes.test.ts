import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { releaseNotes } from '../../../../scripts/lib/releases/notes.mjs';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'puddle-build-notes-'));
  homes.push(repo);
  mkdirSync(join(repo, 'docs/changelogs'), { recursive: true });
  mkdirSync(join(repo, 'packages/daemon'), { recursive: true });
  writeFileSync(join(repo, 'packages/daemon/package.json'), JSON.stringify({ version: '0.4.0' }));
  writeFileSync(
    join(repo, 'CHANGELOG.md'),
    '# Changelog\n\n## [Unreleased]\n\n### Cockpit\n\n- Current\n\n## [0.3.14]\n\n- Previous\n',
  );
  return repo;
}
it('uses an exact archived release before the current development section', () => {
  const repo = fixture();
  writeFileSync(
    join(repo, 'docs/changelogs/CHANGELOG-v0.4.0.md'),
    '# Changelog\n\n## [0.4.0] — date\n\n- Archived\n',
  );
  expect(releaseNotes(repo, '0.4.0')).toBe('## [0.4.0] — date\n\n- Archived\n');
});
it('uses only Unreleased for the exact current version and never borrows another version', () => {
  const repo = fixture();
  expect(releaseNotes(repo, '0.4.0')).toBe('## [Unreleased]\n\n### Cockpit\n\n- Current\n');
  expect(releaseNotes(repo, '0.5.0')).toBeNull();
  expect(() => releaseNotes(repo, '../../private')).toThrow();
});
it('refuses malformed and oversized release content at build time', () => {
  const repo = fixture();
  writeFileSync(join(repo, 'CHANGELOG.md'), '# No matching release');
  expect(() => releaseNotes(repo, '0.4.0')).toThrow(/heading/);
  writeFileSync(join(repo, 'CHANGELOG.md'), '## [Unreleased]\n' + 'é'.repeat(128 * 1024));
  expect(() => releaseNotes(repo, '0.4.0')).toThrow(/256 KiB/);
});
