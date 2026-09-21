import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialisePrivateHome, privateDirectory } from '../src/node/security.js';

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'puddle-private-home-'));
  temporary.push(parent);
  return { parent, home: join(parent, '.puddle') };
}

describe.skipIf(process.platform === 'win32')('Puddle home migration', () => {
  it('creates a private home', () => {
    const { home } = fixture();
    initialisePrivateHome(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it.each([0o755, 0o750])('migrates mode %i without changing existing files', (mode) => {
    const { home } = fixture();
    mkdirSync(home);
    chmodSync(home, mode);
    const data = join(home, 'puddle.db');
    writeFileSync(data, 'existing data');
    chmodSync(data, 0o640);
    initialisePrivateHome(home);
    initialisePrivateHome(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(data, 'utf8')).toBe('existing data');
    expect(statSync(data).mode & 0o777).toBe(0o640);
  });

  it.each(['', '/'])('refuses a symlinked home with suffix "%s"', (suffix) => {
    const { parent, home } = fixture();
    const target = join(parent, 'target');
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, home);
    expect(() => initialisePrivateHome(home + suffix)).toThrow();
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it.each([0o775, 0o757])('refuses mode %i because another user could modify it', (mode) => {
    const { home } = fixture();
    mkdirSync(home);
    chmodSync(home, mode);
    expect(() => initialisePrivateHome(home)).toThrow('not writable by other users');
    expect(statSync(home).mode & 0o777).toBe(mode);
  });

  it('refuses a directory owned by another user', () => {
    const { home } = fixture();
    mkdirSync(home);
    chmodSync(home, 0o755);
    vi.spyOn(process, 'getuid').mockReturnValue(statSync(home).uid + 1);
    expect(() => initialisePrivateHome(home)).toThrow('owned by the current user');
    expect(statSync(home).mode & 0o777).toBe(0o755);
  });

  it('keeps existing authority-directory validation strict', () => {
    const { home } = fixture();
    mkdirSync(home);
    chmodSync(home, 0o755);
    expect(() => privateDirectory(home)).toThrow('must be private');
    expect(statSync(home).mode & 0o777).toBe(0o755);
  });
});
