import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { uiStateSnapshotSchema, type DesktopWorkspaceContent } from '@puddle/shared';
import { DesktopWindowState } from '../../../src/windows/persistence/state.js';
import { type ArrangementRequest } from '../../../src/windows/persistence/arrangements.js';
import { type ReopenWindow, loadReopenWindows } from '../../../src/reopen.js';

const profile = 'aaaaaaaaaa';
const otherProfile = 'bbbbbbbbbb';
const project = '1111111111';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const host: ReopenWindow = { target: 'local', window: { kind: 'host', id: 'host' }, route: '/' };
const pane: ReopenWindow = {
  target: 'local',
  window: { kind: 'pane', id: 'pane', profileId: profile, projectId: project },
};
const dedicated: ReopenWindow = {
  target: 'local',
  window: { kind: 'project', id: 'project', profileId: profile, projectId: project },
};
const replacement: ReopenWindow = {
  target: 'local',
  window: { kind: 'pane', id: 'replacement', profileId: profile, projectId: project },
};
const foreign: ReopenWindow = {
  target: 'local',
  window: { kind: 'pane', id: 'foreign', profileId: otherProfile, projectId: project },
};
const remote: ReopenWindow = { target: 'user@remote', window: { kind: 'host', id: 'remote' } };
function content(...drafts: string[]): DesktopWorkspaceContent {
  return {
    snapshot: uiStateSnapshotSchema.parse({}),
    views: {},
    buffers: drafts.map((text) => ({
      session: 'session',
      path: `${text}.ts`,
      content: text,
      baseMtimeMs: 1,
    })),
  };
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-arrangements-'));
  homes.push(home);
  const file = join(home, 'windows.json');
  const state = new DesktopWindowState(file);
  state.syncOpenWindows([host, pane, dedicated, foreign, remote]);
  state.write('host', profile, 0, content('host draft'));
  state.write('host', otherProfile, 0, content('another profile'));
  state.write('pane', profile, 0, content('pane draft'));
  state.write('project', profile, 0, content('project draft'));
  state.write('foreign', otherProfile, 0, content('foreign draft'));
  state.write('remote', profile, 0, content('remote draft'));
  const request: ArrangementRequest = {
    id: 'arrange',
    ownerId: 'host',
    profileId: profile,
    scope: 'profile',
    changes: [
      { record: host, revision: 1, content: content('host draft'), open: true },
      { record: pane, revision: 1, content: content(), open: false },
      { record: dedicated, revision: 1, content: content(), open: false },
      {
        record: replacement,
        revision: 0,
        content: content('pane draft', 'project draft'),
        open: true,
      },
    ],
  };
  return { state, file, request };
}

it('commits every window revision and retirement together, preserving other hosts and profiles', () => {
  const { state, file, request } = setup();
  const before = readFileSync(file, 'utf8');
  const transaction = state.prepareArrangement(request);
  expect(transaction.activeIds).toEqual(['host', 'pane', 'project']);
  expect(state.read('pane', profile)?.content.buffers).toEqual(content('pane draft').buffers);
  expect(state.read('replacement', profile)).toBeNull();
  expect(state.readPresentation('replacement', profile)?.content.buffers).toEqual(
    content('pane draft', 'project draft').buffers,
  );
  expect(loadReopenWindows(file).map((record) => record.window?.id)).not.toContain('replacement');
  state.commitArrangement('arrange', 'host');
  const committed = readFileSync(file, 'utf8');
  expect(committed).not.toBe(before);
  expect(state.openWindows().map((record) => record.window?.id)).toEqual([
    'host',
    'foreign',
    'remote',
    'replacement',
  ]);
  expect(state.read('host', profile)?.revision).toBe(2);
  expect(state.read('replacement', profile)?.revision).toBe(1);
  expect(state.read('host', otherProfile)?.content).toEqual(content('another profile'));
  expect(state.read('foreign', otherProfile)?.content).toEqual(content('foreign draft'));
  expect(state.read('remote', profile)?.content).toEqual(content('remote draft'));
  state.commitArrangement('arrange', 'host');
  expect(readFileSync(file, 'utf8')).toBe(committed);
  const restored = new DesktopWindowState(file);
  restored.recoverPending();
  expect(restored.arrangementOutcome('arrange', 'host')).toBe('committed');
  expect(restored.openWindows()).toEqual(state.openWindows());
  expect(restored.read('replacement', profile)?.content).toEqual(
    content('pane draft', 'project draft'),
  );
});

it('cancels an interrupted preparation without making staged native windows authoritative', () => {
  const { state, file, request } = setup();
  const originals = state.openWindows();
  state.prepareArrangement(request);
  state.syncOpenWindows([...originals, { ...replacement, route: `/project/${project}` }]);
  expect(state.openWindows()).toEqual(originals);
  const restored = new DesktopWindowState(file);
  restored.recoverPending();
  expect(restored.arrangementOutcome('arrange', 'host')).toBe('cancelled');
  expect(restored.openWindows()).toEqual(originals);
  expect(restored.read('pane', profile)?.content).toEqual(content('pane draft'));
  expect(restored.read('project', profile)?.content).toEqual(content('project draft'));
  expect(() => restored.commitArrangement('arrange', 'host')).toThrow('not prepared');
});

it('includes returned projects and consumes their ownership only at commit', () => {
  const { state, file, request } = setup();
  state.closeProject('project', 1);
  const entries = state.arrangementEntries(request);
  expect(entries.find((entry) => entry.record.window?.id === 'project')).toMatchObject({
    open: false,
    returnedProject: true,
  });
  state.prepareArrangement(request);
  expect(state.returnedProject('project')).not.toBeNull();
  state.cancelArrangement('arrange', 'host');
  expect(new DesktopWindowState(file).returnedProject('project')).not.toBeNull();
  state.prepareArrangement({ ...request, id: 'next' });
  state.commitArrangement('next', 'host');
  expect(state.returnedProject('project')).toBeNull();
});

it('rejects missing dirty buffers and conflicting ownership before any durable change', () => {
  const { state, file, request } = setup();
  const original = readFileSync(file, 'utf8');
  const losing = structuredClone(request);
  losing.changes[3]!.content = content('pane draft');
  expect(() => state.prepareArrangement(losing)).toThrow('unsaved buffer');
  const duplicate = structuredClone(request);
  duplicate.changes[2]!.open = true;
  duplicate.changes[3]!.record = {
    ...replacement,
    window: { kind: 'project', id: 'replacement', profileId: profile, projectId: project },
  };
  expect(() => state.prepareArrangement(duplicate)).toThrow('duplicate a project');
  expect(readFileSync(file, 'utf8')).toBe(original);
});

it('rejects stale revisions, cross-host/profile writes, omitted members and foreign acknowledgements', () => {
  const { state, request } = setup();
  const stale = structuredClone(request);
  stale.changes[1]!.revision = 0;
  expect(() => state.prepareArrangement(stale)).toThrow('state changed');
  const crossed = structuredClone(request);
  crossed.changes[3]!.record.target = 'user@remote';
  expect(() => state.prepareArrangement(crossed)).toThrow('boundary');
  crossed.changes[3]!.record = foreign;
  expect(() => state.prepareArrangement(crossed)).toThrow('boundary');
  expect(() =>
    state.prepareArrangement({
      ...request,
      changes: request.changes.filter((_, index) => index !== 1),
    }),
  ).toThrow('omits');
  state.prepareArrangement(request);
  expect(() => state.commitArrangement('arrange', 'foreign')).toThrow();
  expect(() => state.cancelArrangement('arrange', 'foreign')).toThrow();
  expect(() => state.arrangementOutcome('arrange', 'foreign')).toThrow();
  expect(() => state.write('pane', profile, 1, content('late'))).toThrow('pending');
});

it('keeps the complete original arrangement when the atomic commit write fails', () => {
  const { state, file, request } = setup();
  state.prepareArrangement(request);
  const before = readFileSync(file, 'utf8');
  mkdirSync(`${file}.${process.pid}.tmp`);
  expect(() => state.commitArrangement('arrange', 'host')).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(state.arrangementOutcome('arrange', 'host')).toBe('prepared');
  expect(state.read('pane', profile)?.content).toEqual(content('pane draft'));
});

it('upgrades version-2 recovery records and does not invent an arrangement transaction', () => {
  const { file, state } = setup();
  const old = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  old.version = 2;
  delete old.arrangements;
  delete old.arrangementOutcomes;
  writeFileSync(file, JSON.stringify(old));
  const restored = new DesktopWindowState(file);
  expect(restored.openWindows()).toEqual(state.openWindows());
  expect(restored.read('pane', profile)).toEqual(state.read('pane', profile));
  restored.syncOpenWindows(restored.openWindows());
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(4);
});

it('migrates version-3 recovery and persists huddle tabs only in version 4', () => {
  const { file, state } = setup();
  const old = JSON.parse(readFileSync(file, 'utf8'));
  old.version = 3;
  writeFileSync(file, JSON.stringify(old));
  const restored = new DesktopWindowState(file);
  expect(restored.read('pane', profile)).toEqual(state.read('pane', profile));
  const huddle = content();
  huddle.snapshot = uiStateSnapshotSchema.parse({
    layout_tree: {
      kind: 'leaf',
      id: 'huddle',
      tabs: [{ type: 'huddle', session: '00000000-0000-4000-8000-000000000001' }],
      activeKey: 'huddle:00000000-0000-4000-8000-000000000001',
    },
  });
  restored.write('pane', profile, 1, huddle);
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(4);
  expect(new DesktopWindowState(file).read('pane', profile)?.content).toEqual(huddle);
  const future = JSON.parse(readFileSync(file, 'utf8'));
  future.version = 5;
  writeFileSync(file, JSON.stringify(future));
  expect(() => new DesktopWindowState(file)).toThrow();
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(5);
});

it('allows a staged project replacement while retaining the original owner until commit', () => {
  const { state, request } = setup();
  request.changes[3]!.record = {
    ...replacement,
    window: { kind: 'project', id: 'replacement', profileId: profile, projectId: project },
  };
  state.prepareArrangement(request);
  state.syncOpenWindows([...state.openWindows(), request.changes[3]!.record]);
  expect(state.projectWindow('host', profile, project)?.record.window?.id).toBe('project');
  state.commitArrangement('arrange', 'host');
  expect(state.projectWindow('host', profile, project)?.record.window?.id).toBe('replacement');
});

it('retains native placement changes made while a destination is staged', () => {
  const { state, request } = setup();
  state.prepareArrangement(request);
  const placement = { bounds: { x: 80, y: 40, width: 900, height: 700 }, displayId: 2 };
  state.syncOpenWindows([...state.openWindows(), { ...replacement, placement }]);
  state.commitArrangement('arrange', 'host');
  expect(
    state.openWindows().find((record) => record.window?.id === 'replacement')?.placement,
  ).toEqual(placement);
});

it('excludes concurrent pane handoffs and refuses to persist changed membership during preparation', () => {
  const { state, request } = setup();
  state.prepareArrangement(request);
  expect(() => state.prepareArrangement({ ...request, id: 'overlap' })).toThrow('pending');
  expect(() =>
    state.prepare({
      id: 'pane-transfer',
      sourceId: 'host',
      profileId: profile,
      sourceRevision: 1,
      destinationRevision: 0,
      sourceContent: content('host draft'),
      destinationContent: content(),
      destination: {
        ...replacement,
        window: { kind: 'pane', id: 'new-pane', profileId: profile, projectId: project },
      },
      closeSource: false,
    }),
  ).toThrow('pending');
  expect(() =>
    state.syncOpenWindows([
      ...state.openWindows(),
      {
        ...replacement,
        window: { kind: 'pane', id: 'surprise', profileId: profile, projectId: project },
      },
    ]),
  ).toThrow('membership changed');
  state.cancelArrangement('arrange', 'host');
  expect(state.read('pane', profile)?.content).toEqual(content('pane draft'));
});

it('protects unrelated host project slices in a project-scoped arrangement', () => {
  const { state, request } = setup();
  const otherProject = '2222222222';
  const existing = content('host draft');
  existing.snapshot.layout_mode = 'project';
  existing.snapshot.project_layouts[otherProject] = {
    layout_tree: null,
    active_session: null,
    layout_ref: 7,
  };
  state.write('host', profile, 1, existing);
  request.scope = 'project';
  request.projectId = project;
  request.changes[0]!.revision = 2;
  request.changes[0]!.content = structuredClone(existing);
  request.changes[0]!.content.snapshot.project_layouts[otherProject]!.layout_ref = 8;
  expect(() => state.prepareArrangement(request)).toThrow('another project slice');
  request.changes[0]!.content = existing;
  state.prepareArrangement(request);
  state.commitArrangement('arrange', 'host');
  expect(
    state.read('host', profile)?.content.snapshot.project_layouts[otherProject]?.layout_ref,
  ).toBe(7);
});
