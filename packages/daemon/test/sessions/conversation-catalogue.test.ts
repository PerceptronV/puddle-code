import { mkdtempSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { openDatabase } from '../../src/db/db.js';
import type { NativeConversation } from '../../src/agents/adapter.js';
import {
  ConversationCatalogue,
  type CatalogueScanMeasurement,
} from '../../src/sessions/conversation-catalogue.js';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';

const catalogues: ConversationCatalogue[] = [];
afterEach(async () => {
  await Promise.all(catalogues.splice(0).map((catalogue) => catalogue.dispose()));
  vi.useRealTimers();
});

function setup(
  opts: {
    missingWatchRoot?: boolean;
    fakeClock?: boolean;
    timings?: ConstructorParameters<typeof ConversationCatalogue>[1];
    fakeWatch?: 'healthy' | 'failed';
    archiveProjectBeforeCatalogue?: boolean;
  } = {},
) {
  const parent = mkdtempSync(join(tmpdir(), 'puddle-native-watch-'));
  const root = opts.missingWatchRoot ? join(parent, 'not-created') : parent;
  let native: NativeConversation[] = [];
  let fail = false;
  let release: (() => void) | null = null;
  let watchListener: (() => void) | null = null;
  const discover = vi.fn(async () => {
    if (release) await new Promise<void>((resolve) => (release = resolve));
    if (fail) throw new Error('store unavailable');
    return native;
  });
  const watchRoots = vi.fn(() => [root]);
  const adapter = {
    ...fakeAdapter(),
    conversationDiscovery: { watchRoots, discover },
  };
  const f = fixture({ adapter });
  if (opts.archiveProjectBeforeCatalogue) {
    f.stores.projects.setArchived(f.ids.project, true);
  }
  if (opts.fakeClock) vi.useFakeTimers();
  const catalogue = new ConversationCatalogue(
    {
      accounts: f.stores.accounts,
      conversations: f.stores.conversations,
      projects: f.stores.projects,
      repos: f.stores.repos,
      sessions: f.stores.sessions,
      adapters: f.adapters,
      worktrees: f.worktrees,
    },
    {
      ...(opts.timings ?? {
        healthySweepMs: 60_000,
        watchDebounceMs: 10,
        deletionVerifyMs: 10,
      }),
      ...(opts.fakeWatch === 'healthy'
        ? {
            watchFactory: (_root: string, listener: () => void) => {
              watchListener = listener;
              return { on: () => undefined, close: () => undefined } as unknown as FSWatcher;
            },
          }
        : opts.fakeWatch === 'failed'
          ? {
              watchFactory: () => {
                throw new Error('watch unavailable');
              },
            }
          : {}),
    },
  );
  catalogues.push(catalogue);
  return {
    f,
    catalogue,
    discover,
    watchRoots,
    setNative: (value: NativeConversation[]) => (native = value),
    setFail: (value: boolean) => (fail = value),
    blockNext: () => {
      release = () => undefined;
      return () => {
        const resolve = release;
        release = null;
        resolve?.();
      };
    },
    triggerWatch: () => watchListener?.(),
    currentWatch: () => watchListener,
  };
}

describe('ConversationCatalogue', () => {
  it('observes accepted scan triggers and phases without conversation data', async () => {
    const measurements: Readonly<CatalogueScanMeasurement>[] = [];
    const { f, catalogue, triggerWatch, setNative, setFail } = setup({
      fakeWatch: 'healthy',
      timings: {
        watchDebounceMs: 10,
        deletionVerifyMs: 10,
        healthySweepMs: 60_000,
        observeScan: (measurement) => measurements.push(measurement),
      },
    });
    setNative([
      {
        ref: 'synthetic',
        cwd: f.repoPath,
        title: null,
        parentRef: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    catalogue.refreshProject(f.ids.project);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => measurements.length === 1);
    for (let i = 0; i < 25; i++) triggerWatch();
    await waitFor(() => measurements.length === 3);
    expect(measurements.map((row) => row.trigger)).toEqual(['activation', 'watch', 'verification']);
    expect(
      measurements.every(
        (row) =>
          row.completed &&
          row.conversations === 1 &&
          row.elapsedMs >= row.discoveryMs + row.ingestionMs + row.placementMs,
      ),
    ).toBe(true);
    setFail(true);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => measurements.length === 4);
    expect(measurements[3]).toMatchObject({
      trigger: 'activation',
      conversations: 0,
      completed: false,
    });
  });

  it('writes presence once per discovered row and retains newer lifecycle observations', async () => {
    const { f, catalogue, setNative } = setup({ fakeWatch: 'healthy' });
    const db = openDatabase(f.paths.dbFile, { migrate: false });
    onTestFinished(() => db.close());
    const native: NativeConversation[] = Array.from({ length: 100 }, (_, i) => ({
      ref: `conversation-${i}`,
      cwd: f.repoPath,
      title: 'Synthetic',
      parentRef: null,
      createdAt: null,
      updatedAt: null,
    }));
    setNative(native);
    const complete = vi.spyOn(f.stores.conversations, 'completeSuccessfulScan');
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => complete.mock.calls.length === 1);
    // Count actual SQLite row updates independently of the store's implementation.
    db.exec(`CREATE TABLE observation_writes (count INTEGER NOT NULL);
      INSERT INTO observation_writes VALUES (0);
      CREATE TRIGGER count_observation_writes AFTER UPDATE ON agent_conversations BEGIN
        UPDATE observation_writes SET count = count + 1;
      END;`);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => complete.mock.calls.length === 2);
    expect(db.prepare('SELECT count FROM observation_writes').get()).toEqual({ count: 100 });

    const store = f.stores.conversations;
    const future = '2099-01-01T00:00:00.000Z';
    const row = store.upsert(f.ids.profile, 'fake', f.ids.account, native[0]!, future);
    const refs = new Set(native.map((entry) => entry.ref));
    store.completeSuccessfulScan(f.ids.account, refs, '2098-01-01T00:00:00.000Z');
    expect(store.get(row.id)?.last_seen_at).toBe(future);
    refs.delete(native[0]!.ref);
    expect(store.completeSuccessfulScan(f.ids.account, refs)).toEqual([]);
    expect(store.completeSuccessfulScan(f.ids.account, refs)).toEqual([row.id]);
    refs.add(native[0]!.ref);
    expect(store.completeSuccessfulScan(f.ids.account, refs)).toEqual([row.id]);
    expect(store.get(row.id)).toMatchObject({
      missing: false,
      missing_scan_count: 0,
      last_seen_at: future,
    });
  });

  it('publishes renames before slow placement discovery and shares mappings only within a scan', async () => {
    const { f, catalogue, setNative } = setup({ fakeWatch: 'healthy' });
    const first: NativeConversation = {
      ref: 'first',
      cwd: f.repoPath,
      title: 'First title',
      parentRef: null,
      createdAt: null,
      updatedAt: null,
    };
    const second = { ...first, ref: 'second', title: 'Second title' };
    setNative([first, second]);
    const complete = vi.spyOn(f.stores.conversations, 'completeSuccessfulScan');
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => complete.mock.calls.length === 1);
    const placement = f.service.list().find((session) => session.agent_session_ref === 'second')!;
    const rows = await f.worktrees.listWorktrees(f.stores.repos.get(f.ids.repo));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listing = vi.spyOn(f.worktrees, 'listWorktrees').mockImplementation(async () => {
      await blocked;
      return rows;
    });
    const changed = vi.fn();
    catalogue.on('sessions-changed', changed);
    complete.mockClear();
    setNative([first, { ...second, title: 'Renamed' }, { ...first, ref: 'new-placement' }]);
    catalogue.refreshProject(f.ids.project);
    try {
      await waitFor(() => listing.mock.calls.length === 1);
      // Even a rename later in the account's catalogue is visible while the
      // first conversation's worktree inspection is still blocked.
      expect(f.service.get(placement.id).agent_title).toBe('Renamed');
      expect(changed).toHaveBeenCalledExactlyOnceWith({ projectIds: [f.ids.project] });
      expect(
        f.service.list().some((session) => session.agent_session_ref === 'new-placement'),
      ).toBe(false);
      expect(complete).not.toHaveBeenCalled();
      release();
      await waitFor(() => complete.mock.calls.length === 1);
      expect(listing).toHaveBeenCalledOnce();
      expect(
        f.service.list().some((session) => session.agent_session_ref === 'new-placement'),
      ).toBe(true);
      expect(changed).toHaveBeenCalledTimes(2);

      // Reuse must not hide a filesystem change in the next observation.
      listing.mockResolvedValue([]);
      catalogue.refreshProject(f.ids.project);
      await waitFor(() => complete.mock.calls.length === 2);
      expect(listing).toHaveBeenCalledTimes(2);
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await catalogue.dispose();
      listing.mockRestore();
    }
  });

  it('pauses scans and restores watchers with fresh discovery after release', async () => {
    const { f, catalogue, discover, setNative, blockNext, watchRoots, currentWatch } = setup({
      fakeWatch: 'healthy',
    });
    const oldWatch = currentWatch();
    const release = blockNext();
    catalogue.refreshProject(f.ids.project);
    const upsert = vi.spyOn(f.stores.conversations, 'upsert');
    const complete = vi.spyOn(f.stores.conversations, 'completeSuccessfulScan');
    const hold = catalogue.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    try {
      catalogue.refreshProject('absent');
      await Promise.resolve();
      expect(drained).not.toHaveBeenCalled();
      release();
      await drain;
      expect(upsert).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      setNative([
        {
          ref: 'changed-during-pause',
          cwd: f.repoPath,
          title: 'Fresh',
          parentRef: null,
          createdAt: null,
          updatedAt: null,
        },
      ]);
      hold.release();
      await waitFor(() => complete.mock.calls.length > 0);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(f.service.list().map((session) => session.agent_session_ref)).toContain(
        'changed-during-pause',
      );
      expect(currentWatch()).not.toBe(oldWatch);
      // An old watcher callback must not schedule work on its replacement.
      vi.useFakeTimers();
      oldWatch?.();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      const final = catalogue.pause();
      await final.drain();
      await catalogue.dispose();
      watchRoots.mockClear();
      final.release();
      expect(watchRoots).not.toHaveBeenCalled();
      expect(() => catalogue.pause()).toThrow(/maintenance/);
    } finally {
      vi.useRealTimers();
      release();
      await catalogue.dispose();
      hold.release();
    }
  });

  it('does not coalesce away recovery when a pause is cancelled before discovery settles', async () => {
    const { f, catalogue, discover, blockNext } = setup({ fakeWatch: 'healthy' });
    const release = blockNext();
    catalogue.refreshProject(f.ids.project);
    const hold = catalogue.pause();
    try {
      hold.release();
      // Repeated cancelled pauses still need only one follow-up scan.
      for (let attempt = 0; attempt < 5; attempt++) catalogue.pause().release();
      await Promise.resolve();
      expect(discover).toHaveBeenCalledOnce();
      release();
      await waitFor(() => discover.mock.calls.length === 2);
      await catalogue.dispose();
    } finally {
      release();
      await catalogue.dispose();
      hold.release();
    }
  });

  it('drains discovery on disposal without writing late results or reinstalling watchers', async () => {
    const { f, catalogue, discover, setNative, blockNext, triggerWatch, watchRoots } = setup({
      fakeWatch: 'healthy',
    });
    setNative([
      {
        ref: 'late-discovery',
        cwd: f.repoPath,
        title: 'Late',
        parentRef: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const release = blockNext();
    catalogue.refreshProject(f.ids.project);
    expect(discover).toHaveBeenCalledOnce();
    const upsert = vi.spyOn(f.stores.conversations, 'upsert');
    const complete = vi.spyOn(f.stores.conversations, 'completeSuccessfulScan');
    const changed = vi.fn();
    catalogue.on('sessions-changed', changed);
    const disposed = vi.fn();
    const pending = catalogue.dispose().then(disposed);
    try {
      await Promise.resolve();
      expect(disposed).not.toHaveBeenCalled();
      watchRoots.mockClear();
      // Even an invalid id must not touch the store once disposed.
      catalogue.refreshProject('absent');
      catalogue.reconcileWatchers();
      triggerWatch();
      release();
      await pending;
      await catalogue.dispose();
      expect(upsert).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(watchRoots).not.toHaveBeenCalled();
      expect(discover).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
    }
  });

  it('waits for Git mapping but never materialises a placement or marks missing after disposal', async () => {
    const { f, catalogue, setNative } = setup({ fakeWatch: 'healthy' });
    const rows = await f.worktrees.listWorktrees(f.stores.repos.get(f.ids.repo));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listing = vi.spyOn(f.worktrees, 'listWorktrees').mockImplementation(async () => {
      await blocked;
      return rows;
    });
    setNative([
      {
        ref: 'late-mapping',
        cwd: f.repoPath,
        title: 'Late',
        parentRef: null,
        createdAt: null,
        updatedAt: null,
      },
    ]);
    const create = vi.spyOn(f.stores.sessions, 'create');
    const complete = vi.spyOn(f.stores.conversations, 'completeSuccessfulScan');
    catalogue.refreshProject(f.ids.project);
    try {
      await waitFor(() => listing.mock.calls.length === 1);
      const disposed = vi.fn();
      const pending = catalogue.dispose().then(disposed);
      await Promise.resolve();
      expect(disposed).not.toHaveBeenCalled();
      release();
      await pending;
      expect(create).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      release();
      listing.mockRestore();
      await catalogue.dispose();
    }
  });

  it('materialises eligible project placements without crossing profile or archive boundaries', async () => {
    const { f, catalogue, setNative } = setup();
    const second = f.stores.projects.create({
      profile_id: f.ids.profile,
      repo_id: f.ids.repo,
      name: 'second',
    });
    const archived = f.stores.projects.create({
      profile_id: f.ids.profile,
      repo_id: f.ids.repo,
      name: 'archived',
    });
    f.stores.projects.setArchived(archived.id, true);
    const foreignProfile = f.stores.profiles.create({ name: 'foreign', branch_prefix: 'foreign/' });
    const foreign = f.stores.projects.create({
      profile_id: foreignProfile.id,
      repo_id: f.ids.repo,
      name: 'foreign',
    });
    setNative([
      {
        ref: 'native-one',
        cwd: f.repoPath,
        title: 'Native title',
        parentRef: null,
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      },
    ]);

    catalogue.refreshProject(f.ids.project);
    await waitFor(
      () =>
        f.service.list().filter((session) => session.agent_session_ref === 'native-one').length ===
        2,
    );
    const placements = f.service
      .list()
      .filter((session) => session.agent_session_ref === 'native-one');
    expect(new Set(placements.map((session) => session.project_id))).toEqual(
      new Set([f.ids.project, second.id]),
    );
    expect(placements.every((session) => session.status === 'exited')).toBe(true);
    expect(placements.every((session) => session.branch_owner === false)).toBe(true);
    expect(placements.some((session) => session.project_id === archived.id)).toBe(false);
    expect(placements.some((session) => session.project_id === foreign.id)).toBe(false);
  });

  it('never unarchives through polling and confirms missing state on two successful scans', async () => {
    const { f, catalogue, discover, setNative, setFail } = setup();
    const metadata: NativeConversation = {
      ref: 'native-two',
      cwd: f.repoPath,
      title: 'First title',
      parentRef: null,
      createdAt: null,
      updatedAt: '2026-08-21T00:00:00.000Z',
    };
    setNative([metadata]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() =>
      f.service.list().some((session) => session.agent_session_ref === metadata.ref),
    );
    const placement = f.service
      .list()
      .find((session) => session.agent_session_ref === metadata.ref)!;
    f.stores.sessions.setStatus(placement.id, 'archived');
    const changedProjects: string[][] = [];
    catalogue.on('sessions-changed', ({ projectIds }) => changedProjects.push(projectIds));

    setNative([{ ...metadata, title: 'Renamed natively' }]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(
      () =>
        f.service.get(placement.id).agent_title === 'Renamed natively' &&
        changedProjects.some((projectIds) => projectIds.includes(f.ids.project)),
    );
    expect(f.service.get(placement.id).status).toBe('archived');
    expect(changedProjects.some((projectIds) => projectIds.includes(f.ids.project))).toBe(true);

    setNative([]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.stores.conversations.list()[0]?.missing_scan_count === 1);
    expect(f.service.get(placement.id).conversation_missing).not.toBe(true);

    // A failed pass never advances provisional deletion state.
    setFail(true);
    const calls = discover.mock.calls.length;
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => discover.mock.calls.length > calls);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.stores.conversations.list()[0]?.missing_scan_count).toBe(1);

    setFail(false);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.service.get(placement.id).conversation_missing === true);
    setNative([{ ...metadata, title: 'Back again' }]);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.service.get(placement.id).conversation_missing !== true);
    expect(f.service.get(placement.id).agent_title).toBe('Back again');
  });

  it('does not discard activation after a scan has published its metadata', async () => {
    const { f, catalogue, discover, setNative } = setup({ fakeWatch: 'healthy' });
    const first: NativeConversation = {
      ref: 'refresh-boundary',
      cwd: f.repoPath,
      title: 'Before',
      parentRef: null,
      createdAt: null,
      updatedAt: null,
    };
    setNative([first]);
    catalogue.once('sessions-changed', () => {
      setNative([{ ...first, title: 'After' }]);
      catalogue.refreshProject(f.ids.project);
    });
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => f.service.list().some((session) => session.agent_title === 'After'));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent activation refreshes for one account', async () => {
    const { f, catalogue, discover, setNative, blockNext } = setup();
    setNative([]);
    const release = blockNext();
    catalogue.refreshProject(f.ids.project);
    catalogue.refreshProject(f.ids.project);
    await waitFor(() => discover.mock.calls.length === 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('debounces store events and schedules one short deletion verification', async () => {
    const { discover, triggerWatch } = setup({
      fakeClock: true,
      fakeWatch: 'healthy',
      timings: {
        healthySweepMs: 5 * 60_000,
        watchDebounceMs: 250,
        deletionVerifyMs: 1_500,
      },
    });
    triggerWatch();
    triggerWatch();
    triggerWatch();
    await vi.advanceTimersByTimeAsync(249);
    expect(discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('runs the healthy safety sweep at five minutes and adaptively backs off failed watches', async () => {
    const healthy = setup({
      fakeClock: true,
      fakeWatch: 'healthy',
      timings: { healthySweepMs: 5 * 60_000 },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(healthy.discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(healthy.discover).toHaveBeenCalledTimes(1);
    await healthy.catalogue.dispose();

    const fallback = setup({
      fakeClock: true,
      fakeWatch: 'failed',
      missingWatchRoot: true,
      timings: {
        healthySweepMs: 5 * 60_000,
        fallbackMinMs: 15_000,
        fallbackMaxMs: 5 * 60_000,
      },
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fallback.discover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback.discover).toHaveBeenCalledTimes(1);
    // First changed fingerprint keeps the minimum; then unchanged scans back
    // off to 30s and 60s rather than waking every 15s forever.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fallback.discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fallback.discover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback.discover).toHaveBeenCalledTimes(3);
  });

  it('installs no watches without an eligible project and becomes eligible on unarchive', () => {
    const { f, catalogue, watchRoots } = setup({
      archiveProjectBeforeCatalogue: true,
      fakeWatch: 'healthy',
    });
    expect(watchRoots).not.toHaveBeenCalled();
    f.stores.projects.setArchived(f.ids.project, false);
    catalogue.reconcileWatchers();
    expect(watchRoots).toHaveBeenCalledTimes(1);
  });
});
