import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { requireNoHostRemoval } from '../../src/node/installation/removal.js';
import { inspectHostRemoval } from '../../src/node/installation/removal-records.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-removal-fence-'));
  homes.push(home);
  const directory = join(home, 'installation/removal');
  return { home, directory, file: join(directory, 'services.json') };
}

it('does not create state while inspecting an absent removal', () => {
  const f = fixture();
  const absent = join(f.home, 'absent');
  requireNoHostRemoval(absent);
  expect(inspectHostRemoval(absent)).toEqual({ state: 'none' });
  expect(existsSync(absent)).toBe(false);
  requireNoHostRemoval(f.home);
  expect(inspectHostRemoval(f.home)).toEqual({ state: 'none' });
  expect(existsSync(join(f.home, 'installation'))).toBe(false);
});

it.each(['valid', 'malformed', 'directory', 'dangling-link'] as const)(
  'refuses an active %s record without interpreting its contents',
  (kind) => {
    const f = fixture();
    mkdirSync(f.directory, { recursive: true, mode: 0o700 });
    if (kind === 'directory') mkdirSync(f.file, { mode: 0o700 });
    else if (kind === 'dangling-link') symlinkSync(join(f.home, 'missing'), f.file);
    else writeFileSync(f.file, kind === 'valid' ? '{}' : '{', { mode: 0o600 });
    expect(() => requireNoHostRemoval(f.home)).toThrow('Resolve the recorded host removal');
    expect(() => inspectHostRemoval(f.home)).toThrow();
  },
);

it('ignores the bounded cancelled archive after the active record has been moved', () => {
  const f = fixture();
  mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  writeFileSync(f.file, '{}', { mode: 0o600 });
  expect(() => requireNoHostRemoval(f.home)).toThrow();
  renameSync(f.file, join(f.directory, 'cancelled-services.json'));
  requireNoHostRemoval(f.home);
});

it.each(['linked', 'shared'] as const)('refuses an unsafe %s removal parent', (kind) => {
  const f = fixture();
  if (kind === 'linked') symlinkSync(join(f.home, 'missing'), join(f.home, 'installation'));
  else {
    mkdirSync(f.directory, { recursive: true, mode: 0o700 });
    chmodSync(f.directory, 0o755);
  }
  expect(() => requireNoHostRemoval(f.home)).toThrow(/private/);
  expect(() => inspectHostRemoval(f.home)).toThrow(/private/);
});
