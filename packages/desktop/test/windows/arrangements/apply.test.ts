import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopArrangementApplyRequest,
  type DesktopWindowCommand,
} from '@puddle/shared';
import { DesktopWindowState } from '../../../src/windows/persistence/state.js';
import { WindowLayoutApply } from '../../../src/windows/arrangements/apply.js';
import { WindowCommands } from '../../../src/windows/lifecycle/commands.js';
import { WindowNavigations } from '../../../src/windows/hosts/navigation.js';
import type { ReopenWindow } from '../../../src/reopen.js';
import { ArrangementParticipant } from '../../../../web/src/features/windows/arrangements/participant.js';
import { planWindowArrangement } from '../../../../web/src/features/windows/arrangements/plan.js';
import { DesktopWorkingSet } from '../../../../web/src/features/windows/state/working-set.js';
import { DesktopContentState } from '../../../../web/src/features/windows/state/content-state.js';
import { registerRendererLifecycle } from '../../../../web/src/features/windows/lifecycle/renderer-lifecycle.js';
import { makeLeaf } from '../../../../web/src/features/workspace/layout/layout-tree.js';

const profileId = 'aaaaaaaaaa';
const projectId = '1111111111';
const session = '00000000-0000-4000-8000-000000000001';
const homes: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const tree = (path: string) => makeLeaf([{ type: 'editor', tab: { session, path } }]);

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-layout-apply-'));
  homes.push(home);
  const file = join(home, 'windows.json');
  const state = new DesktopWindowState(file);
  const records = new Map<string, ReopenWindow>([
    ['host', { target: 'local', window: { kind: 'host', id: 'host' }, route: '/' }],
    [
      'pane',
      {
        target: 'local',
        window: { kind: 'pane', id: 'pane', profileId, projectId },
        route: `/project/${projectId}`,
      },
    ],
  ]);
  state.syncOpenWindows([...records.values()]);
  for (const id of records.keys())
    state.write(id, profileId, 0, {
      snapshot: uiStateSnapshotSchema.parse({
        layout_mode: 'profile',
        layout_tree: tree(`${id}.ts`),
      }),
      buffers: [{ session, path: `${id}.ts`, content: `${id} edits`, baseMtimeMs: 1 }],
      views: {},
    });
  const commands = new WindowCommands(200);
  const navigation = new WindowNavigations();
  const owners = new Map<string, DesktopWorkingSet>();
  const contents = new Map<string, DesktopContentState>();
  let failMount = false;
  async function renderer(id: string) {
    let staged = state.stagingArrangement(id)?.transaction.id;
    const content = new DesktopContentState();
    contents.set(id, content);
    const owner = new DesktopWorkingSet(
      profileId,
      {
        read: async () => state.readPresentation(id, profileId),
        write: async (request) => state.write(id, profileId, request.revision, request.content),
      },
      content,
      vi.fn(),
      undefined,
      !!staged,
    );
    content.subscribe(() => owner.changed());
    owners.set(id, owner);
    await owner.load(async () => {
      throw new Error('No seed expected');
    });
    const participant = new ArrangementParticipant(
      {
        activeProfile: () => profileId,
        owner: async () => owner,
        read: async () => state.readPresentation(id, profileId),
        initialArrangement: () => staged,
        staging: (id) => {
          staged = id;
        },
        fence: vi.fn(),
        suspend: (hidden) => {
          if (!hidden && !(failMount && id !== 'host' && id !== 'pane'))
            queueMicrotask(() => participant.mounted(profileId));
        },
        route: () => records.get(id)!.route ?? '/',
        navigate: (route) => {
          records.get(id)!.route = route;
        },
      },
      50,
    );
    let receive!: (command: DesktopWindowCommand) => void;
    await registerRendererLifecycle(
      {
        onCommand: (callback) => {
          receive = callback;
          return () => commands.disconnected(id);
        },
        ready: async () => commands.ready(id, (command) => receive(command)),
        reply: async (reply) => commands.reply(id, reply),
      },
      () => [],
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      (command) => participant.command(command),
      async (command) => planWindowArrangement(command, new Map([[session, projectId]])),
    );
  }
  await renderer('host');
  await renderer('pane');
  const dependencies = {
    state: () => state,
    admit: (id: string) => records.get(id)!,
    record: (id: string) => structuredClone(records.get(id)!),
    run: (target: string, key: string, action: () => Promise<void>) =>
      navigation.run(target, key, action),
    validate: (ids: string[]) => {
      for (const id of ids) if (!commands.available(id)) throw new Error('Renderer unavailable');
    },
    generation: (id: string) => commands.generation(id),
    ready: (id: string) => commands.whenReady(id),
    command: vi.fn(commands.arrangement.bind(commands)),
    plan: vi.fn(commands.planArrangement.bind(commands)),
    open: vi.fn(async (record: ReopenWindow) => {
      expect(navigation.busy('local')).toBe(true);
      records.set(record.window!.id, structuredClone(record));
      state.syncOpenWindows([...records.values()]);
      await renderer(record.window!.id);
    }),
    dismiss: vi.fn((id: string) => {
      commands.disconnected(id);
      records.delete(id);
    }),
    reload: vi.fn(renderer),
    committed: vi.fn(),
    report: vi.fn(),
  };
  const apply = new WindowLayoutApply(dependencies);
  const request: DesktopArrangementApplyRequest = {
    id: 'apply',
    profileId,
    scope: 'profile',
    layoutRef: 7,
    arrangement: {
      version: 1,
      windows: [
        {
          key: 'host-slot',
          kind: 'host',
          project_id: null,
          layout_mode: 'profile',
          layout_tree: tree('host.ts'),
          active_session: null,
          project_layouts: {},
        },
        {
          key: 'project-slot',
          kind: 'project',
          project_id: projectId,
          layout_mode: 'profile',
          layout_tree: tree('pane.ts'),
          active_session: null,
          project_layouts: {},
        },
      ],
    },
  };
  return {
    state,
    file,
    records,
    owners,
    contents,
    commands,
    dependencies,
    apply,
    request,
    failMount: () => {
      failMount = true;
    },
  };
}

it('applies through real renderer planning, reuses the project on repeated loads and retires sources only after commit', async () => {
  const f = await setup();
  expect(await f.apply.apply('host', f.request)).toEqual({ status: 'committed' });
  expect(f.dependencies.open).toHaveBeenCalledTimes(1);
  const project = f.state.openWindows().find((record) => record.window?.kind === 'project')!;
  expect(f.state.read(project.window!.id, profileId)!.content.buffers[0]!.content).toBe(
    'pane edits',
  );
  expect(f.dependencies.dismiss).toHaveBeenCalledWith('pane');
  expect(f.owners.get('host')!.locked()).toBe(false);
  expect(f.owners.get(project.window!.id)!.locked()).toBe(false);
  expect(await f.apply.apply('host', { ...f.request, id: 'again' })).toEqual({
    status: 'committed',
  });
  expect(f.dependencies.open).toHaveBeenCalledTimes(1);
  expect(f.state.openWindows().map((record) => record.window!.id)).toEqual([
    'host',
    project.window!.id,
  ]);
  await expect(f.apply.apply('host', f.request)).rejects.toThrow('already requested');
  expect(f.apply.observe('host', { id: 'apply', profileId })).toEqual({ status: 'committed' });
  expect(() => f.apply.observe('host', { id: 'apply', profileId: 'bbbbbbbbbb' })).toThrow(
    'another profile',
  );
  const restarted = new DesktopWindowState(f.file);
  restarted.recoverPending();
  expect(restarted.openWindows()).toEqual(f.state.openWindows());
});

it('cancels a failed native mount and restores every original without retiring its dirty source', async () => {
  const f = await setup();
  f.failMount();
  const applying = f.apply.apply('host', f.request);
  await vi.advanceTimersByTimeAsync(60);
  expect(await applying).toEqual({
    status: 'cancelled',
    error: 'The prepared window did not finish mounting',
  });
  expect(f.state.openWindows().map((record) => record.window!.id)).toEqual(['host', 'pane']);
  expect(f.dependencies.dismiss).not.toHaveBeenCalledWith('pane');
  expect(f.state.read('pane', profileId)!.content.buffers[0]!.content).toBe('pane edits');
  expect(f.owners.get('host')!.locked()).toBe(false);
  expect(f.owners.get('pane')!.locked()).toBe(false);
  expect(new DesktopWindowState(f.file).arrangementOutcome('apply', 'host')).toBe('cancelled');
});

it('cancels a rejected plan before creating windows and durably consumes the failed operation id', async () => {
  const f = await setup();
  f.dependencies.plan.mockRejectedValueOnce(new Error('Draft conflict'));
  expect(await f.apply.apply('host', f.request)).toEqual({
    status: 'cancelled',
    error: 'Draft conflict',
  });
  expect(f.dependencies.open).not.toHaveBeenCalled();
  expect(f.owners.get('host')!.locked()).toBe(false);
  expect(f.owners.get('pane')!.locked()).toBe(false);
  expect(new DesktopWindowState(f.file).arrangementOutcome('apply', 'host')).toBe('cancelled');
});

it('reloads a replaced renderer from the original durable state and cancels the remaining participants', async () => {
  const f = await setup();
  f.dependencies.plan.mockImplementationOnce(async (id, command) => {
    const planned = await f.commands.planArrangement(id, command);
    f.commands.ready('host', vi.fn());
    return planned;
  });
  expect((await f.apply.apply('host', f.request)).status).toBe('cancelled');
  expect(f.dependencies.reload).toHaveBeenCalledExactlyOnceWith('host');
  expect(f.dependencies.open).not.toHaveBeenCalled();
  expect(f.state.read('host', profileId)!.content.buffers[0]!.content).toBe('host edits');
});

it('observes a lost finish acknowledgement without replaying the apply or reopening its windows', async () => {
  const f = await setup();
  let lost = false;
  f.dependencies.command.mockImplementation(async (id, command) => {
    const reply = await f.commands.arrangement(id, command);
    if (!lost && command.kind === 'finish-layout' && command.outcome === 'committed') {
      lost = true;
      throw new Error('Lost reply');
    }
    return reply;
  });
  expect(await f.apply.apply('host', f.request)).toEqual({ status: 'committed' });
  expect(f.dependencies.open).toHaveBeenCalledTimes(1);
  expect(f.dependencies.reload).not.toHaveBeenCalled();
  expect(f.owners.get('host')!.locked()).toBe(false);
});

it('keeps original ownership when the atomic commit fails', async () => {
  const f = await setup();
  vi.spyOn(f.state, 'commitArrangement').mockImplementationOnce(() => {
    throw new Error('Disk write failed');
  });
  expect(await f.apply.apply('host', f.request)).toEqual({
    status: 'cancelled',
    error: 'Disk write failed',
  });
  expect(f.state.openWindows().map((record) => record.window!.id)).toEqual(['host', 'pane']);
  expect(f.dependencies.dismiss).not.toHaveBeenCalledWith('pane');
});

it('retains late destination edits in a durable recovery window instead of destroying them during cancellation', async () => {
  const f = await setup();
  f.dependencies.command.mockImplementation(async (id, command) => {
    const reply = await f.commands.arrangement(id, command);
    if (command.kind === 'stage-layout' && id !== 'host') {
      f.contents.get(id)!.restore({
        ...command.version.content,
        buffers: [
          ...command.version.content.buffers,
          { session, path: 'late.ts', content: 'late destination edit', baseMtimeMs: 1 },
        ],
      });
    }
    return reply;
  });
  expect((await f.apply.apply('host', f.request)).status).toBe('cancelled');
  expect(f.state.read('pane', profileId)!.content.buffers[0]!.content).toBe('pane edits');
  const recovery = f.state.openWindows().find((record) => record.window?.kind === 'project')!;
  expect(recovery).toBeDefined();
  const saved = f.state.read(recovery.window!.id, profileId)!;
  expect(saved.content.buffers.some((buffer) => buffer.content === 'late destination edit')).toBe(
    true,
  );
  expect(JSON.stringify(saved.content.snapshot.layout_tree)).toContain('late.ts');
  expect(f.owners.get(recovery.window!.id)!.locked()).toBe(false);
  expect(f.dependencies.dismiss).not.toHaveBeenCalledWith(recovery.window!.id);
  expect(new DesktopWindowState(f.file).openWindows()).toEqual(f.state.openWindows());
});

it('reopens an exact retained pane slot with its prior dirty working set', async () => {
  const f = await setup();
  f.commands.disconnected('pane');
  f.records.delete('pane');
  f.state.syncOpenWindows([...f.records.values()]);
  Object.assign(f.request.arrangement.windows[1]!, { kind: 'pane', key: 'pane' });
  expect(await f.apply.apply('host', f.request)).toEqual({ status: 'committed' });
  expect(f.dependencies.open.mock.calls[0]![0].window!.id).toBe('pane');
  expect(f.state.read('pane', profileId)!.content.buffers[0]!.content).toBe('pane edits');
});

it('applies a selected project without involving another project, profile or host', async () => {
  const f = await setup();
  const foreign: ReopenWindow[] = [
    {
      target: 'local',
      window: { kind: 'pane', id: 'other-project', profileId, projectId: '2222222222' },
    },
    {
      target: 'local',
      window: { kind: 'pane', id: 'other-profile', profileId: 'bbbbbbbbbb', projectId },
    },
    { target: 'user@remote', window: { kind: 'host', id: 'remote' } },
  ];
  for (const record of foreign) f.records.set(record.window!.id, record);
  f.state.syncOpenWindows([...f.records.values()]);
  for (const record of foreign)
    f.state.write(
      record.window!.id,
      record.window!.kind === 'host' ? profileId : record.window!.profileId,
      0,
      { snapshot: uiStateSnapshotSchema.parse({}), buffers: [], views: {} },
    );
  const before = foreign.map((record) =>
    f.state.read(
      record.window!.id,
      record.window!.kind === 'host' ? profileId : record.window!.profileId,
    ),
  );
  f.request.scope = 'project';
  f.request.projectId = projectId;
  Object.assign(f.request.arrangement.windows[0]!, {
    project_id: projectId,
    layout_mode: 'project',
    layout_tree: null,
    project_layouts: { [projectId]: { layout_tree: tree('host.ts'), active_session: null } },
  });
  expect(await f.apply.apply('host', f.request)).toEqual({ status: 'committed' });
  expect(f.state.read('host', profileId)!.content.snapshot.layout_mode).toBe('profile');
  expect(
    foreign.map((record) =>
      f.state.read(
        record.window!.id,
        record.window!.kind === 'host' ? profileId : record.window!.profileId,
      ),
    ),
  ).toEqual(before);
  const final = f.state.openWindows().map((record) => record.window!.id);
  for (const record of foreign) expect(final).toContain(record.window!.id);
  expect(
    f.dependencies.command.mock.calls.every(
      ([id]) => !foreign.some((record) => record.window!.id === id),
    ),
  ).toBe(true);
});

it('keeps a reopened closed slot’s omitted original drafts when late edits require cancellation recovery', async () => {
  const f = await setup();
  const previous = f.state.read('pane', profileId)!;
  f.state.write('pane', profileId, previous.revision, {
    ...previous.content,
    buffers: [
      ...previous.content.buffers,
      { session, path: 'retained.ts', content: 'retained original', baseMtimeMs: 1 },
    ],
  });
  f.commands.disconnected('pane');
  f.records.delete('pane');
  f.state.syncOpenWindows([...f.records.values()]);
  Object.assign(f.request.arrangement.windows[1]!, { kind: 'pane', key: 'pane' });
  f.request.arrangement.windows[0]!.layout_tree = makeLeaf([
    { type: 'editor', tab: { session, path: 'host.ts' } },
    { type: 'editor', tab: { session, path: 'retained.ts' } },
  ]);
  f.dependencies.command.mockImplementation(async (id, command) => {
    const reply = await f.commands.arrangement(id, command);
    if (command.kind === 'stage-layout' && id === 'pane')
      f.contents.get(id)!.restore({
        ...command.version.content,
        buffers: [
          ...command.version.content.buffers,
          { session, path: 'late.ts', content: 'late edit', baseMtimeMs: 1 },
        ],
      });
    return reply;
  });
  expect((await f.apply.apply('host', f.request)).status).toBe('cancelled');
  const recovery = f.state.read('pane', profileId)!.content;
  expect(recovery.buffers.map((buffer) => buffer.content).sort()).toEqual([
    'late edit',
    'pane edits',
    'retained original',
  ]);
  expect(JSON.stringify(recovery.snapshot.layout_tree)).toContain('retained.ts');
  expect(f.owners.get('pane')!.locked()).toBe(false);
});
