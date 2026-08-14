import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadWindowTargets, saveWindowTargets } from '../src/reopen';

describe('desktop window target persistence', () => {
  it('keeps the standing target set across repeated launches', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    saveWindowTargets(file, ['local', 'user@host']);

    expect(loadWindowTargets(file)).toEqual(['local', 'user@host']);
    expect(loadWindowTargets(file)).toEqual(['local', 'user@host']);
  });

  it('writes an empty set so explicitly closed windows do not return', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    saveWindowTargets(file, ['local']);
    saveWindowTargets(file, []);

    expect(loadWindowTargets(file)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ targets: [] });
  });

  it('accepts a fresh former update-only file and sanitises its targets', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    const now = Date.parse('2026-08-13T12:05:00.000Z');
    writeFileSync(
      file,
      JSON.stringify({
        writtenAt: '2026-08-13T12:00:00.000Z',
        targets: ['local', 'local', 42, 'user@host'],
      }),
    );

    expect(loadWindowTargets(file, now)).toEqual(['local', 'user@host']);
  });

  it('keeps the former update-only TTL during migration', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    writeFileSync(
      file,
      JSON.stringify({ writtenAt: '2026-08-13T12:00:00.000Z', targets: ['local'] }),
    );

    expect(loadWindowTargets(file, Date.parse('2026-08-13T12:20:00.000Z'))).toEqual([]);
  });
});
