import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiStateSnapshotSchema, type DesktopWorkspaceContent } from '@puddle/shared';
import { loadReopenWindows, saveReopenWindows, type ReopenWindow } from '../../../src/reopen.js';
import { DesktopWindowState } from '../../../src/windows/persistence/state.js';

const profile = '1234567890';
const project = 'abcdef1234';
const source: ReopenWindow = { target: 'local', window: { id: 'source', kind: 'host' } };
const destination: ReopenWindow = {
  target: 'local',
  window: { id: 'destination', kind: 'pane', profileId: profile, projectId: project },
};
const projectWindow: ReopenWindow = {
  target: 'local',
  window: { id: 'project-window', kind: 'project', profileId: profile, projectId: project },
};
const homes: string[] = [];
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-window-state-'));
  homes.push(home);
  const file = join(home, 'reopen-windows.json');
  const store = new DesktopWindowState(file);
  store.syncOpenWindows([source]);
  return { store, file };
}
function content(text?: string): DesktopWorkspaceContent {
  return {
    snapshot: uiStateSnapshotSchema.parse({}),
    buffers:
      text === undefined
        ? []
        : [{ session: 'session', path: 'dirty.ts', content: text, baseMtimeMs: 123 }],
    views: {},
  };
}
function prepare(
  store: DesktopWindowState,
  overrides: Partial<Parameters<DesktopWindowState['prepare']>[0]> = {},
) {
  return store.prepare({
    id: 'transfer',
    sourceId: 'source',
    destination,
    profileId: profile,
    sourceRevision: 1,
    destinationRevision: 0,
    sourceContent: content(),
    destinationContent: content('unsaved'),
    closeSource: false,
    ...overrides,
  });
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('durable desktop working sets and acknowledged transfers', () => {
  it('retains a closed project without a host window and returns it in the combined seed', () => {
    const { store, file } = setup();
    store.syncOpenWindows([source, projectWindow]);
    store.write('project-window', profile, 0, content('latest project draft'));
    expect(() => store.closeProject('project-window', 0)).toThrow('state changed');
    store.closeProject('project-window', 1);
    store.syncOpenWindows([]);
    const restored = new DesktopWindowState(file);
    expect(restored.openWindows()).toEqual([]);
    expect(loadReopenWindows(file)).toEqual([]);
    expect(restored.returnedProject('project-window')?.version.content.buffers).toEqual(
      content('latest project draft').buffers,
    );
    expect(restored.projectWindow('source', profile, project)).toMatchObject({
      open: false,
      returned: true,
    });
    expect(restored.seed('source', profile).detached).toHaveLength(1);
    expect(() => restored.write('project-window', profile, 1, content('stale write'))).toThrow(
      'closed',
    );
    expect(() => restored.syncOpenWindows([projectWindow])).toThrow('Reopen');
    expect(restored.reopenProject('project-window')).toEqual(projectWindow);
    restored.syncOpenWindows([projectWindow]);
    expect(restored.returnedProject('project-window')).toBeNull();
    expect(restored.read('project-window', profile)?.content.buffers).toEqual(
      content('latest project draft').buffers,
    );
  });

  it('keeps quit-style open projects distinct from explicit return and validates project ownership', () => {
    const { store, file } = setup();
    store.syncOpenWindows([
      projectWindow,
      { target: 'other-host', window: { kind: 'host', id: 'other-host' } },
    ]);
    store.write('project-window', profile, 0, content('draft'));
    const restored = new DesktopWindowState(file);
    expect(restored.openWindows()).toContainEqual(projectWindow);
    expect(restored.returnedProject('project-window')).toBeNull();
    expect(restored.projectWindow('source', profile, project)).toMatchObject({
      open: true,
      returned: false,
    });
    expect(restored.projectWindow('source', '0000000000', project)).toBeNull();
    expect(restored.projectWindow('other-host', profile, project)).toBeNull();
    expect(() => restored.closeProject('source', 0)).toThrow('Only project windows');
  });

  it('refuses a second dedicated project owner, including while the first is staged or returned', () => {
    const { store } = setup();
    store.write('source', profile, 0, content('unsaved'));
    prepare(store, { destination: projectWindow });
    const second = { ...projectWindow, window: { ...projectWindow.window!, id: 'second-project' } };
    const sibling: ReopenWindow = {
      target: 'local',
      window: { kind: 'pane', id: 'sibling', profileId: profile, projectId: project },
    };
    store.syncOpenWindows([source, sibling]);
    store.write('sibling', profile, 0, content());
    const duplicate = () =>
      prepare(store, { id: 'duplicate', sourceId: 'sibling', destination: second });
    expect(duplicate).toThrow('already has a window');
    store.commit('transfer', 'project-window');
    expect(duplicate).toThrow('already has a window');
    store.closeProject('project-window', 1);
    expect(duplicate).toThrow('already has a window');
  });
  it('finds an existing pane only on the same host and profile', () => {
    const { store } = setup();
    const ref = {
      type: 'editor' as const,
      tab: { session: '00000000-0000-4000-8000-000000000001', path: 'a.ts' },
    };
    store.syncOpenWindows([
      source,
      destination,
      { target: 'other-host', window: { kind: 'host', id: 'other' } },
    ]);
    store.write('destination', profile, 0, {
      ...content(),
      snapshot: uiStateSnapshotSchema.parse({
        layout_tree: {
          kind: 'leaf',
          id: 'leaf',
          tabs: [ref],
          activeKey: null,
        },
      }),
    });
    expect(store.findPane('source', profile, ref)).toBe('destination');
    expect(store.findPane('other', profile, ref)).toBeNull();
    expect(store.findPane('source', '0000000000', ref)).toBeNull();
    expect(
      store.findPane('source', profile, { ...ref, tab: { ...ref.tab, root: '/different' } }),
    ).toBeNull();
  });
  it('migrates target-only reopen state and retains working sets across close/reopen', () => {
    const { file } = setup();
    saveReopenWindows(file, [{ target: 'user@host' }]);
    const store = new DesktopWindowState(file);
    expect(store.openWindows()).toEqual([{ target: 'user@host' }]);
    store.syncOpenWindows([source]);
    store.write('source', profile, 0, content('unsaved'));
    store.syncOpenWindows([]);
    const restored = new DesktopWindowState(file);
    expect(restored.openWindows()).toEqual([]);
    expect(restored.read('source', profile)?.content.buffers[0]?.content).toBe('unsaved');
    restored.syncOpenWindows([source]);
    expect(restored.read('source', profile)?.revision).toBe(1);
    expect(loadReopenWindows(file)).toEqual([source]);
  });

  it('rejects stale updates without clobbering another window or profile', () => {
    const { store } = setup();
    store.syncOpenWindows([source, destination]);
    store.write('source', profile, 0, content('source text'));
    store.write('destination', profile, 0, content('different text'));
    expect(() => store.write('source', profile, 0, content('stale'))).toThrow('changed');
    expect(store.read('source', profile)?.content.buffers[0]?.content).toBe('source text');
    expect(store.read('destination', profile)?.content.buffers[0]?.content).toBe('different text');
    expect(() => store.read('destination', '0000000000')).toThrow('another profile');
  });

  it('prepares without retiring the source, then commits both revisions atomically', () => {
    const { store, file } = setup();
    store.write('source', profile, 0, content('unsaved'));
    prepare(store);
    expect(store.outcome('transfer')).toBe('prepared');
    expect(store.read('source', profile)?.content.buffers[0]?.content).toBe('unsaved');
    expect(store.read('destination', profile)).toBeNull();
    expect(store.openWindows()).toEqual([source]);
    expect(() => store.write('source', profile, 1, content('racing edit'))).toThrow('pending');
    expect(() => store.write('destination', profile, 0, content())).toThrow('pending');
    expect(() => store.commit('transfer', 'wrong-window')).toThrow('does not match');
    store.commit('transfer', 'destination');
    const restored = new DesktopWindowState(file);
    expect(restored.outcome('transfer')).toBe('committed');
    expect(restored.read('source', profile)).toEqual({ revision: 2, content: content() });
    expect(restored.read('destination', profile)).toEqual({
      revision: 1,
      content: content('unsaved'),
    });
    expect(restored.openWindows()).toEqual([source, destination]);
    // A lost reply may only observe/reacknowledge, never repeat the move.
    restored.commit('transfer', 'destination');
    expect(restored.read('destination', profile)?.revision).toBe(1);
    expect(() => prepare(restored)).toThrow('already recorded');
  });

  it('returns a prepared source after process interruption and never revives its unaccepted destination', () => {
    const { store, file } = setup();
    store.write('source', profile, 0, content('unsaved'));
    prepare(store, { closeSource: true });
    // A native destination may exist for preparation but is not yet owned.
    store.syncOpenWindows([source, destination]);
    expect(store.openWindows()).toEqual([source]);
    const restored = new DesktopWindowState(file);
    restored.recoverPending();
    expect(restored.outcome('transfer')).toBe('cancelled');
    expect(restored.openWindows()).toEqual([source]);
    expect(restored.read('source', profile)?.content).toEqual(content('unsaved'));
    expect(() => restored.commit('transfer', 'destination')).toThrow('does not match');
    restored.write('source', profile, 1, content('continued editing'));
  });

  it('retains a committed destination after interruption and honours source closure', () => {
    const { store, file } = setup();
    store.write('source', profile, 0, content('unsaved'));
    prepare(store, { closeSource: true });
    store.commit('transfer', 'destination');
    const restored = new DesktopWindowState(file);
    restored.recoverPending();
    expect(restored.openWindows()).toEqual([destination]);
    expect(loadReopenWindows(file)).toEqual([destination]);
    expect(restored.read('destination', profile)?.content).toEqual(content('unsaved'));
  });

  it('rejects handoffs that lose dirty source or destination buffers', () => {
    const { store } = setup();
    store.write('source', profile, 0, content('unsaved'));
    expect(() => prepare(store, { destinationContent: content('older text') })).toThrow(
      'discard an unsaved buffer',
    );
    store.syncOpenWindows([source, destination]);
    store.write('destination', profile, 0, content('independent edits'));
    expect(() => prepare(store, { destinationRevision: 1 })).toThrow('discard an unsaved buffer');
    expect(store.outcome('transfer')).toBeNull();
  });

  it('rejects cross-host/profile destinations and racing transfers', () => {
    const { store } = setup();
    store.write('source', profile, 0, content('unsaved'));
    expect(() => prepare(store, { destination: { ...destination, target: 'remote' } })).toThrow(
      'between hosts',
    );
    expect(() =>
      prepare(store, {
        destination: {
          ...destination,
          window: { id: 'other', kind: 'pane', profileId: '0000000000', projectId: project },
        },
      }),
    ).toThrow('between profiles');
    prepare(store);
    expect(() => prepare(store, { id: 'racing' })).toThrow('pending');
    store.cancel('transfer');
    expect(store.outcome('transfer')).toBe('cancelled');
    expect(() => prepare(store, { id: 'next' })).not.toThrow();
  });

  it('does not publish a revision or acceptance if durable persistence fails', () => {
    const { store, file } = setup();
    store.write('source', profile, 0, content('unsaved'));
    prepare(store);
    const before = readFileSync(file, 'utf8');
    mkdirSync(`${file}.${process.pid}.tmp`);
    expect(() => store.commit('transfer', 'destination')).toThrow();
    expect(store.outcome('transfer')).toBe('prepared');
    expect(store.read('source', profile)?.revision).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
    rmSync(`${file}.${process.pid}.tmp`, { recursive: true });
    store.commit('transfer', 'destination');
    expect(store.outcome('transfer')).toBe('committed');
  });
});
