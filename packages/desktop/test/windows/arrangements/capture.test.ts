import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema } from '@puddle/shared';
import { WindowLayoutCapture } from '../../../src/windows/arrangements/capture.js';
import { DesktopWindowState } from '../../../src/windows/persistence/state.js';
import { WindowNavigations } from '../../../src/windows/hosts/navigation.js';
import type { ReopenWindow } from '../../../src/reopen.js';

const profileId = 'aaaaaaaaaa';
const projectId = '1111111111';
const otherProject = '2222222222';
const host: ReopenWindow = { target: 'local', window: { kind: 'host', id: 'host' }, route: '/' };
const project: ReopenWindow = {
  target: 'local',
  window: { kind: 'project', id: 'project', profileId, projectId },
};
const pane: ReopenWindow = {
  target: 'local',
  window: { kind: 'pane', id: 'pane', profileId, projectId: otherProject },
};
const foreign: ReopenWindow = {
  target: 'local',
  window: { kind: 'pane', id: 'foreign', profileId: 'bbbbbbbbbb', projectId },
};
const remote: ReopenWindow = { target: 'user@remote', window: { kind: 'host', id: 'remote' } };
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-layout-capture-'));
  homes.push(home);
  const state = new DesktopWindowState(join(home, 'windows.json'));
  state.syncOpenWindows([host, project, pane, foreign, remote]);
  for (const record of [host, project, pane])
    state.write(record.window!.id, profileId, 0, {
      snapshot: uiStateSnapshotSchema.parse({}),
      buffers: [{ session: 's', path: 'a.ts', content: 'private text', baseMtimeMs: 1 }],
      views: { cursor: 7 },
    });
  const navigation = new WindowNavigations();
  const validate = vi.fn();
  const checkpoint = vi.fn(async (id: string) => {
    const version = state.read(id, profileId)!;
    state.write(id, profileId, version.revision, {
      ...version.content,
      snapshot: { ...version.content.snapshot, sidebar_collapsed: true },
    });
  });
  const resume = vi.fn(async (_ids: string[]) => {});
  const capture = new WindowLayoutCapture({
    state: () => state,
    record: () => host,
    run: (target, key, action) => navigation.run(target, key, action),
    validate,
    checkpoint,
    resume,
  });
  return { state, navigation, capture, checkpoint, resume, validate };
}

it('captures post-checkpoint structure from one host/profile and omits dirty buffers and native target data', async () => {
  const f = setup();
  const result = await f.capture.capture('host', { profileId, scope: 'profile' });
  expect(f.checkpoint.mock.calls.map(([id]) => id)).toEqual(['host', 'pane', 'project']);
  expect(result.entries.map((entry) => entry.identity.id)).toEqual(['host', 'pane', 'project']);
  expect(
    result.entries.every((entry) => entry.revision === 2 && entry.snapshot.sidebar_collapsed),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/private text|cursor|user@remote|target/);
  expect(f.resume).toHaveBeenCalledExactlyOnceWith(['host', 'pane', 'project']);
  expect(f.navigation.busy('local')).toBe(false);
});

it('includes durable returned projects without requiring their renderer, while project scope excludes other panes', async () => {
  const f = setup();
  f.state.closeProject('project', 1);
  const result = await f.capture.capture('host', { profileId, scope: 'project', projectId });
  expect(f.checkpoint.mock.calls.map(([id]) => id)).toEqual(['host']);
  expect(result.entries.map((entry) => entry.identity.id)).toEqual(['host', 'project']);
  expect(result.entries[1]).toMatchObject({ open: false, returnedProject: true, revision: 1 });
  expect(f.state.returnedProject('project')).not.toBeNull();
});

it('waits for all checkpoint replies before resuming after one sibling fails', async () => {
  const f = setup();
  const pending = Promise.withResolvers<void>();
  f.checkpoint.mockImplementation(async (id) => {
    if (id === 'host') throw new Error('save failed');
    if (id === 'pane') await pending.promise;
  });
  const capture = f.capture.capture('host', { profileId, scope: 'profile' });
  await vi.waitFor(() => expect(f.checkpoint).toHaveBeenCalledTimes(3));
  expect(f.resume).not.toHaveBeenCalled();
  pending.resolve();
  await expect(capture).rejects.toThrow('save failed');
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.navigation.busy('local')).toBe(false);
});

it('rejects membership/route changes and resumption failures instead of returning a partial capture', async () => {
  const f = setup();
  f.checkpoint.mockImplementation(async () => {
    f.state.syncOpenWindows([
      host,
      { ...project, route: `/project/${projectId}` },
      pane,
      foreign,
      remote,
    ]);
  });
  await expect(f.capture.capture('host', { profileId, scope: 'profile' })).rejects.toThrow(
    'changed during',
  );
  expect(f.resume).toHaveBeenCalledOnce();
  f.resume.mockRejectedValue(new Error('resume failed'));
  await expect(f.capture.capture('host', { profileId, scope: 'profile' })).rejects.toThrow(
    'resume failed',
  );
});

it('does not checkpoint an unavailable or busy participant', async () => {
  const f = setup();
  f.validate.mockImplementation(() => {
    throw new Error('window unavailable');
  });
  await expect(f.capture.capture('host', { profileId, scope: 'profile' })).rejects.toThrow(
    'unavailable',
  );
  expect(f.checkpoint).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled();
});
