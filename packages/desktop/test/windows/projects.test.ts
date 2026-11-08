import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { uiStateSnapshotSchema, type DesktopProjectCommand } from '@puddle/shared';
import { ProjectWindows } from '../../src/windows/projects.js';
import { DesktopWindowState } from '../../src/windows/persistence/state.js';
import { reopenWindowId, type ReopenWindow } from '../../src/reopen.js';

const profileId = '1234567890';
const projectId = 'abcdef1234';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-projects-'));
  homes.push(home);
  const state = new DesktopWindowState(join(home, 'windows.json'));
  const host: ReopenWindow = { target: 'local', window: { kind: 'host', id: 'host' }, route: '/' };
  const project: ReopenWindow = {
    target: 'local',
    window: { kind: 'project', id: 'project', projectId, profileId },
    route: `/project/${projectId}`,
  };
  const pane: ReopenWindow = {
    target: 'local',
    window: { kind: 'pane', id: 'pane', projectId: '0000000001', profileId },
  };
  const live = new Map([host, project, pane].map((record) => [reopenWindowId(record), record]));
  state.syncOpenWindows([...live.values()]);
  state.write('project', profileId, 0, {
    snapshot: uiStateSnapshotSchema.parse({}),
    buffers: [{ session: 's', path: 'dirty.ts', content: 'retained', baseMtimeMs: 1 }],
    views: {},
  });
  const transfers = {
    busy: vi.fn(() => false),
    prepareProject: vi.fn(async () => undefined),
    restoreProject: vi.fn(async () => undefined),
  };
  const open = vi.fn(async (record: ReopenWindow) => {
    live.set(reopenWindowId(record), record);
    state.syncOpenWindows([...live.values()]);
  });
  const raise = vi.fn();
  const command = vi.fn(async (_id: string, _command: DesktopProjectCommand) => undefined);
  const projects = new ProjectWindows({
    state: () => state,
    transfers,
    open,
    raise,
    command,
    record: (id) => {
      const record = live.get(id);
      if (!record) throw new Error('Unavailable');
      return record;
    },
  });
  const close = (id: string) => {
    if (id === 'project') state.closeProject(id, 1);
    live.delete(id);
    state.syncOpenWindows([...live.values()]);
  };
  return { state, projects, live, close, open, command, raise, transfers };
}

it('focuses one project owner and routes session navigation without changing the host workspace', async () => {
  const f = setup();
  expect(await f.projects.focus('host', { profileId, projectId })).toBe(true);
  expect(f.raise).toHaveBeenCalledWith('project');
  const request = {
    profileId,
    route: `/project/${projectId}/session/00000000-0000-4000-8000-000000000001`,
  };
  expect(await f.projects.route('host', request)).toBe(true);
  expect(f.command).toHaveBeenCalledWith('project', { kind: 'navigate-project', ...request });
  expect(f.live.size).toBe(3);
  expect(await f.projects.route('project', request)).toBe(false);
  expect(await f.projects.route('host', { profileId, route: '/' })).toBe(false);
});

it('restores a returned workspace on a host visit and reopens it unchanged on an explicit open', async () => {
  const f = setup();
  f.close('project');
  const request = { profileId, route: `/project/${projectId}` };
  expect(await f.projects.route('host', request)).toBe(true);
  expect(f.transfers.restoreProject).toHaveBeenCalledWith(
    'project',
    'host',
    profileId,
    request.route,
  );
  expect(f.command).not.toHaveBeenCalled();
  expect(await f.projects.focus('host', { profileId, projectId })).toBe(true);
  expect(f.state.returnedProject('project')).toBeNull();
  expect(f.state.read('project', profileId)?.content.buffers[0]?.content).toBe('retained');
});

it('keeps a returned workspace available after failed native creation and blocks reopening during a move', async () => {
  const f = setup();
  f.close('project');
  f.open.mockRejectedValueOnce(new Error('native creation failed'));
  await expect(f.projects.focus('host', { profileId, projectId })).rejects.toThrow(
    'creation failed',
  );
  expect(f.state.returnedProject('project')).not.toBeNull();
  f.transfers.busy.mockReturnValue(true);
  await expect(f.projects.focus('host', { profileId, projectId })).rejects.toThrow('being moved');
  expect(f.open).toHaveBeenCalledOnce();
});

it('opens a host only when a detached window asks to visit or detach another project', async () => {
  const f = setup();
  f.close('host');
  expect(await f.projects.route('project', { profileId, route: `/project/${projectId}` })).toBe(
    false,
  );
  expect(f.open).not.toHaveBeenCalled();
  const another = { profileId, projectId: '0000000002' };
  expect(await f.projects.focus('project', another)).toBe(true);
  const host = [...f.live.values()].find((record) => record.window?.kind === 'host')!;
  expect(f.command).toHaveBeenCalledWith(reopenWindowId(host), {
    kind: 'open-project',
    ...another,
  });
  expect(await f.projects.route('pane', { profileId, route: '/' })).toBe(true);
  expect(f.command).toHaveBeenLastCalledWith(reopenWindowId(host), {
    kind: 'navigate-project',
    profileId,
    route: '/',
  });
});

it('keeps returned state when an open is cancelled before registering a native window', async () => {
  const f = setup();
  f.close('project');
  f.open.mockResolvedValueOnce(undefined);
  await expect(f.projects.focus('host', { profileId, projectId })).rejects.toThrow('Unavailable');
  expect(f.state.returnedProject('project')).not.toBeNull();
});

it('leaves new host project opens to the renderer and does not borrow another profile owner', async () => {
  const f = setup();
  expect(await f.projects.focus('host', { profileId: '0000000000', projectId })).toBe(false);
  expect(
    await f.projects.route('host', { profileId: '0000000000', route: `/project/${projectId}` }),
  ).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
});
