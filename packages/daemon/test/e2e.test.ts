import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  Account,
  Profile,
  Project,
  Repo,
  RepoWithOrphans,
  Session,
  WsServerMessage,
} from '@puddle/shared';
import { startDaemon, type RunningDaemon } from '../src/daemon.js';
import { fakeAdapter } from './helpers/daemon-fixtures.js';
import { initRepo } from './helpers/git-fixtures.js';
import { waitFor } from './helpers/daemon-fixtures.js';

/** Thin authenticated fetch client against a live daemon. */
function client(daemon: RunningDaemon) {
  const base = `http://127.0.0.1:${daemon.port}`;
  return {
    async req(method: string, path: string, body?: unknown, token?: string) {
      const res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${token ?? daemon.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return res;
    },
    async json<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await this.req(method, path, body);
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
      return (await res.json()) as T;
    },
  };
}

/** WS test client: authenticates, collects every server message. */
function wsClient(daemon: RunningDaemon) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
  const messages: WsServerMessage[] = [];
  ws.addEventListener('message', (evt) => {
    messages.push(JSON.parse(String(evt.data)) as WsServerMessage);
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ t: 'auth', token: daemon.token }));
      resolve();
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  return {
    ws,
    messages,
    open,
    send(msg: unknown) {
      ws.send(JSON.stringify(msg));
    },
    outputFor(session: string, term = 'agent'): string {
      return messages
        .filter(
          (m) => (m.t === 'output' || m.t === 'replay') && m.session === session && m.term === term,
        )
        .map((m) => (m as { data: string }).data)
        .join('');
    },
    close() {
      ws.close();
    },
  };
}

async function pollUntil(cond: () => Promise<boolean>, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('pollUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('daemon end-to-end (Phase 1 acceptance)', () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-e2e-home-'));
  const repoPath = initRepo();
  let daemon: RunningDaemon;
  const stops: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const stop of stops.reverse()) await stop().catch(() => undefined);
  });

  async function boot(): Promise<RunningDaemon> {
    const d = await startDaemon({
      home,
      port: 0,
      adapters: [fakeAdapter()],
      assetsDir: null,
      version: 'e2e',
      statusQuietMs: 150,
    });
    stops.push(() => d.stop());
    return d;
  }

  it('boots, rejects tokenless and wrong-token requests', async () => {
    daemon = await boot();
    const c = client(daemon);
    const anon = await fetch(`http://127.0.0.1:${daemon.port}/api/version`);
    expect(anon.status).toBe(401);
    const bad = await c.req('GET', '/api/version', undefined, 'f'.repeat(64));
    expect(bad.status).toBe(401);
    const ok = await c.req('GET', '/api/version');
    expect(ok.status).toBe(200);
  });

  let profile: Profile;
  let alice1: Account;
  let alice2: Account;
  let repo: Repo;
  let project: Project;
  let s1: Session;
  let s2: Session;

  it('sets up profile → accounts → repo → project over REST', async () => {
    const c = client(daemon);
    profile = await c.json<Profile>('POST', '/api/profiles', {
      name: 'alice',
      branch_prefix: 'alice/',
    });
    alice1 = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'personal',
    });
    alice2 = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'org',
    });
    expect(alice1.config_dir).toContain('/profiles/alice/accounts/fake/personal');
    expect(alice2.config_dir).toContain('/profiles/alice/accounts/fake/org');

    const badRepo = await c.req('POST', '/api/repos', { path: '/definitely/not/a/repo' });
    expect(badRepo.status).toBe(400);
    repo = await c.json<Repo>('POST', '/api/repos', {
      path: repoPath,
      onboarding_notes: 'always run make setup',
    });
    project = await c.json<Project>('POST', '/api/projects', {
      profile_id: profile.id,
      repo_id: repo.id,
      name: 'demo',
    });
  });

  it('lists agent adapters and patches profile prefix and account opt-in', async () => {
    const c = client(daemon);
    const agents = await c.json<Array<{ id: string; capabilities: { skip_permissions: boolean } }>>(
      'GET',
      '/api/agents',
    );
    expect(agents.map((a) => a.id)).toEqual(['fake']);

    const renamedPrefix = await c.json<Profile>('PATCH', `/api/profiles/${profile.id}`, {
      branch_prefix: 'team/alice/',
    });
    expect(renamedPrefix.branch_prefix).toBe('team/alice/');
    await c.json<Profile>('PATCH', `/api/profiles/${profile.id}`, { branch_prefix: 'alice/' });

    const optedIn = await c.json<Account>('PATCH', `/api/accounts/${alice1.id}`, {
      skip_permissions_default: true,
    });
    expect(optedIn.skip_permissions_default).toBe(true);
    const optedOut = await c.json<Account>('PATCH', `/api/accounts/${alice1.id}`, {
      skip_permissions_default: false,
    });
    expect(optedOut.skip_permissions_default).toBe(false);
  });

  it('suggests directories (dotdirs included) with git detection', async () => {
    const c = client(daemon);
    const parent = join(repoPath, '..');
    // Near-unique prefix: the OS tmpdir holds many fixture dirs and the
    // endpoint caps its answer at 50 entries.
    const partial = basename(repoPath).slice(0, -1);
    const { entries } = await c.json<{
      entries: Array<{ path: string; name: string; is_git: boolean }>;
    }>('GET', `/api/fs/dirs?prefix=${encodeURIComponent(join(parent, partial))}`);
    const repoEntry = entries.find((e) => e.path === repoPath);
    expect(repoEntry?.is_git).toBe(true);

    // Dotdirs are listed too (the repo's .git itself, when completing inside it).
    const inside = await c.json<{ entries: Array<{ name: string }> }>(
      'GET',
      `/api/fs/dirs?prefix=${encodeURIComponent(repoPath + '/.g')}`,
    );
    expect(inside.entries.some((e) => e.name === '.git')).toBe(true);

    const relative = await c.req('GET', '/api/fs/dirs?prefix=not-absolute');
    expect(relative.status).toBe(400);
  });

  it('rejects skip_permissions against the closed gate with 400', async () => {
    const c = client(daemon);
    const res = await c.req('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      skip_permissions: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('skip_permissions_denied');
  });

  it('runs two sessions on two accounts with interleaved WS streaming', async () => {
    const c = client(daemon);
    s1 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      title: 'first task',
      prompt: 'do thing one',
    });
    s2 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice2.id,
      title: 'second task',
      prompt: 'do thing two',
    });
    expect(s1.branch).toBe('alice/first-task');
    expect(s2.branch).toBe('alice/second-task');

    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'subscribe-status' });
    viewer.send({ t: 'attach', session: s1.id, term: 'agent', cols: 100, rows: 30 });
    viewer.send({ t: 'attach', session: s2.id, term: 'agent', cols: 100, rows: 30 });

    await waitFor(
      () => viewer.outputFor(s1.id).includes('READY') && viewer.outputFor(s2.id).includes('READY'),
    );
    // Onboarding preamble reached both fresh worktrees, with each task prompt.
    expect(viewer.outputFor(s1.id)).toContain('[puddle onboarding]');
    expect(viewer.outputFor(s1.id)).toContain('do thing one');
    expect(viewer.outputFor(s2.id)).toContain('do thing two');
    expect(viewer.outputFor(s2.id)).toContain('always run make setup');

    // stdin round-trips through the PTY (fake agent cats it back).
    viewer.send({ t: 'stdin', session: s1.id, term: 'agent', data: 'hello-agent-one\n' });
    await waitFor(() => viewer.outputFor(s1.id).includes('hello-agent-one'));

    // status broadcasts arrive for the subscriber.
    await waitFor(() => viewer.messages.some((m) => m.t === 'status' && m.session === s1.id));
    viewer.close();
  });

  it('serves the WS spawn-shell flow', async () => {
    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'spawn-shell', session: s1.id });
    await waitFor(() => viewer.messages.some((m) => m.t === 'shell-spawned'));
    const spawned = viewer.messages.find((m) => m.t === 'shell-spawned') as {
      session: string;
      term: string;
    };
    expect(spawned.term).toBe('shell-1');
    viewer.send({ t: 'attach', session: s1.id, term: spawned.term, cols: 80, rows: 24 });
    viewer.send({ t: 'stdin', session: s1.id, term: spawned.term, data: 'pwd\n' });
    await waitFor(() => viewer.outputFor(s1.id, spawned.term).includes(s1.worktree_path));
    viewer.close();
  });

  it('syncs .puddle/onboarding-notes.md into the repo row', async () => {
    const c = client(daemon);
    writeFileSync(
      join(s1.worktree_path, '.puddle', 'onboarding-notes.md'),
      'always run make setup\nnever touch docker\n',
    );
    await pollUntil(async () => {
      const repos = await c.json<RepoWithOrphans[]>('GET', '/api/repos');
      return repos[0]?.onboarding_notes?.includes('docker') ?? false;
    });
  });

  it('restart marks sessions interrupted; resume restores; logs replay', async () => {
    await daemon.stop();
    daemon = await boot(); // reconcile pass runs here

    const c = client(daemon);
    const after1 = await c.json<Session>('GET', `/api/sessions/${s1.id}`);
    const after2 = await c.json<Session>('GET', `/api/sessions/${s2.id}`);
    expect(after1.status).toBe('interrupted');
    expect(after2.status).toBe('interrupted');

    const resumed = await c.json<Session>('POST', `/api/sessions/${s1.id}/resume`);
    expect(resumed.status).toBe('running');

    const viewer = wsClient(daemon);
    await viewer.open;
    viewer.send({ t: 'attach', session: s1.id, term: 'agent', cols: 100, rows: 30 });
    // Replay carries pre-restart output; live output shows the resume + note.
    await waitFor(() => viewer.outputFor(s1.id).includes('do thing one'));
    await waitFor(() => viewer.outputFor(s1.id).includes(`RESUME ref=fake-ref-${s1.id}`));
    await waitFor(() => viewer.outputFor(s1.id).includes('This session was interrupted'));
    viewer.close();

    await c.json<Session>('POST', `/api/sessions/${s1.id}/kill`);
  });

  it('archives: session worktree removed, project archive sweeps the rest', async () => {
    const c = client(daemon);
    const archived = await c.json<Session>('POST', `/api/sessions/${s1.id}/archive`, {
      force: true,
    });
    expect(archived.status).toBe('archived');
    const res = await c.req('POST', `/api/projects/${project.id}/archive`, { force: true });
    expect(res.status).toBe(204);
    const all = await c.json<Session[]>('GET', `/api/sessions?project=${project.id}`);
    expect(all.every((s) => s.status === 'archived')).toBe(true);
  });

  it('stores per-client ui state; other clients seed from it without clobbering', async () => {
    const c = client(daemon);
    const noState = await c.req('GET', `/api/projects/${project.id}/state?client=client-a`);
    expect(noState.status).toBe(404);
    expect(((await noState.json()) as { error: { code: string } }).error.code).toBe('no_state');

    const snapshotA = {
      session_tabs: [s1.id, s2.id],
      active_session: s1.id,
      editor_tabs: [],
      layout: { sidebar: 24 },
      explorer_pin: null,
    };
    await c.json('PUT', `/api/projects/${project.id}/state?client=client-a`, {
      ui_state: snapshotA,
    });

    // Client A reads its own row back; client B falls back to A's snapshot.
    const ownRow = await c.json<{ ui_state: typeof snapshotA }>(
      'GET',
      `/api/projects/${project.id}/state?client=client-a`,
    );
    expect(ownRow.ui_state).toEqual(snapshotA);
    const seeded = await c.json<{ ui_state: typeof snapshotA }>(
      'GET',
      `/api/projects/${project.id}/state?client=client-b`,
    );
    expect(seeded.ui_state).toEqual(snapshotA);

    // B's writes land in B's row and never clobber A's.
    await c.json('PUT', `/api/projects/${project.id}/state?client=client-b`, {
      ui_state: { ...snapshotA, active_session: s2.id },
    });
    const aAfter = await c.json<{ ui_state: { active_session: string } }>(
      'GET',
      `/api/projects/${project.id}/state?client=client-a`,
    );
    expect(aAfter.ui_state.active_session).toBe(s1.id);
  });

  it('login PTY flow marks the account logged in on clean exit', async () => {
    const c = client(daemon);
    const login = await c.json<{ stream: string; term: string }>(
      'POST',
      `/api/accounts/${alice1.id}/login`,
    );
    expect(login.stream).toBe(`login-${alice1.id}`);
    await pollUntil(async () => {
      const accounts = await c.json<Account[]>('GET', `/api/accounts?profile=${profile.id}`);
      return accounts.find((a) => a.id === alice1.id)?.logged_in ?? false;
    });
  });

  it('refuses deletion while sessions are live, then cascades account and profile', async () => {
    const c = client(daemon);
    // A fresh session (running) blocks both deletions with 409s.
    const s3 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice2.id,
      title: 'blocker',
    });
    const accountBlocked = await c.req('DELETE', `/api/accounts/${alice2.id}`);
    expect(accountBlocked.status).toBe(409);
    const profileBlocked = await c.req('DELETE', `/api/profiles/${profile.id}`);
    expect(profileBlocked.status).toBe(409);

    await c.json<Session>('POST', `/api/sessions/${s3.id}/kill`);
    await c.json<Session>('POST', `/api/sessions/${s3.id}/archive`, { force: true });

    // Account deletion removes its rows and its config dir on disk.
    const accountGone = await c.req('DELETE', `/api/accounts/${alice2.id}`);
    expect(accountGone.status).toBe(204);
    const remaining = await c.json<Account[]>('GET', `/api/accounts?profile=${profile.id}`);
    expect(remaining.map((a) => a.id)).toEqual([alice1.id]);
    expect(existsSync(alice2.config_dir)).toBe(false);
    expect(existsSync(alice1.config_dir)).toBe(true);

    // Profile deletion sweeps projects, remaining accounts, and the profile dir.
    const profileGone = await c.req('DELETE', `/api/profiles/${profile.id}`);
    expect(profileGone.status).toBe(204);
    expect(await c.json<unknown[]>('GET', '/api/profiles')).toEqual([]);
    expect(await c.json<unknown[]>('GET', '/api/projects')).toEqual([]);
    expect(existsSync(join(daemon.paths.profilesDir, 'alice'))).toBe(false);
  });
});
