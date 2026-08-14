import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadReopenWindows, saveReopenWindows } from '../src/reopen';

describe('desktop window target and placement persistence', () => {
  it('keeps targets and valid placement across repeated launches', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    const windows = [
      {
        target: 'local',
        placement: {
          bounds: { x: 1440, y: 30, width: 1200, height: 800 },
          displayId: 7,
          displayLabel: 'External Display',
          displayWorkArea: { x: 1440, y: 25, width: 1920, height: 1055 },
          workspace: 3,
        },
      },
      { target: 'user@host' },
    ];
    saveReopenWindows(file, windows);

    expect(loadReopenWindows(file)).toEqual(windows);
    expect(loadReopenWindows(file)).toEqual(windows);
  });

  it('writes an empty set so explicitly closed windows do not return', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    saveReopenWindows(file, [{ target: 'local' }]);
    saveReopenWindows(file, []);

    expect(loadReopenWindows(file)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ windows: [] });
  });

  it('migrates the previous target-only standing state', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    writeFileSync(file, JSON.stringify({ targets: ['local', 'local', 42, 'user@host'] }));

    expect(loadReopenWindows(file)).toEqual([{ target: 'local' }, { target: 'user@host' }]);
  });

  it('accepts a fresh former update-only file and keeps its migration TTL', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    writeFileSync(
      file,
      JSON.stringify({
        writtenAt: '2026-08-13T12:00:00.000Z',
        targets: ['local', 'local', 42, 'user@host'],
      }),
    );

    expect(loadReopenWindows(file, Date.parse('2026-08-13T12:05:00.000Z'))).toEqual([
      { target: 'local' },
      { target: 'user@host' },
    ]);
    expect(loadReopenWindows(file, Date.parse('2026-08-13T12:20:00.000Z'))).toEqual([]);
  });

  it('drops malformed placement without dropping its target', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    writeFileSync(
      file,
      JSON.stringify({
        windows: [
          { target: 'local', placement: { bounds: { x: 0, y: 0, width: -1, height: 900 } } },
          {
            target: 'user@host',
            placement: {
              bounds: { x: 2, y: 3, width: 800, height: 600 },
              workspace: 0xffff_ffff,
              displayId: 'not-a-display',
            },
          },
        ],
      }),
    );

    expect(loadReopenWindows(file)).toEqual([
      { target: 'local' },
      {
        target: 'user@host',
        placement: { bounds: { x: 2, y: 3, width: 800, height: 600 } },
      },
    ]);
  });
});
