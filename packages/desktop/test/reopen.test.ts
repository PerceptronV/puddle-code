import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadReopenWindows, saveReopenWindows } from '../src/reopen';

describe('desktop window target and placement persistence', () => {
  it('retains several distinct windows per host, including a detached-only host', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    const windows = [
      { target: 'local', window: { kind: 'host' as const, id: 'host-window' }, route: '/' },
      {
        target: 'local',
        window: {
          kind: 'project' as const,
          id: 'project-window',
          profileId: '1234567890',
          projectId: 'abcdef1234',
        },
        route: '/project/abcdef1234',
      },
      {
        target: 'local',
        window: {
          kind: 'pane' as const,
          id: 'pane-window',
          profileId: '1234567890',
          projectId: 'abcdef1234',
        },
      },
      {
        target: 'user@host',
        window: {
          kind: 'pane' as const,
          id: 'remote-pane',
          profileId: '1234567890',
          projectId: 'abcdef1234',
        },
      },
    ];
    saveReopenWindows(file, windows);
    expect(loadReopenWindows(file)).toEqual(windows);
  });

  it('rejects duplicate ownership and invalid identities without inventing host windows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    const project = {
      kind: 'project',
      id: 'project-window',
      profileId: '1234567890',
      projectId: 'abcdef1234',
    };
    writeFileSync(
      file,
      JSON.stringify({
        windows: [
          { target: 'local' },
          { target: 'local', window: { kind: 'host', id: 'duplicate-host' } },
          { target: 'local', window: project },
          { target: 'local', window: { ...project, id: 'duplicate-project' } },
          { target: 'other', window: project },
          { target: 'invalid', window: { kind: 'future', id: 'unknown' } },
          { target: 'invalid', window: { kind: 'pane', id: 'pane', projectId: 'not-valid' } },
        ],
      }),
    );
    expect(loadReopenWindows(file)).toEqual([
      { target: 'local' },
      { target: 'local', window: project },
    ]);
  });

  it('never retains invitations, origins or arbitrary URLs in saved routes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    writeFileSync(
      file,
      JSON.stringify({
        windows: [
          { target: 'a', route: '/?invite=secret' },
          { target: 'b', route: '/#invite=secret' },
          { target: 'c', route: 'https://example.com/' },
          { target: 'd', route: '//example.com/' },
          { target: 'e', route: '/project/abcdef1234' },
        ],
      }),
    );
    expect(loadReopenWindows(file)).toEqual([
      { target: 'a' },
      { target: 'b' },
      { target: 'c' },
      { target: 'd' },
      { target: 'e', route: '/project/abcdef1234' },
    ]);
  });

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

  it('keeps the last complete snapshot when a replacement cannot be written', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'puddle-window-state-')), 'windows.json');
    saveReopenWindows(file, [{ target: 'local' }]);
    // Block the temporary write without changing the existing snapshot.
    mkdirSync(`${file}.${process.pid}.tmp`);
    expect(() => saveReopenWindows(file, [{ target: 'user@host' }])).not.toThrow();
    expect(loadReopenWindows(file)).toEqual([{ target: 'local' }]);
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
