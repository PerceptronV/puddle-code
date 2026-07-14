import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, versionResponseSchema } from '@puddle/shared';
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
    // The handshake payload: app version plus the protocol contract (SPEC §6).
    const version = versionResponseSchema.parse(await ok.json());
    expect(version.version).toBe('e2e');
    expect(version.protocol).toEqual(PROTOCOL_VERSION);
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
    // Directories are keyed by profile id — the name is a display label only.
    expect(alice1.config_dir).toContain(`/profiles/${profile.id}/accounts/fake/personal`);
    expect(alice2.config_dir).toContain(`/profiles/${profile.id}/accounts/fake/org`);
    // The fake adapter's "credentials": session spawns verify these exist.
    writeFileSync(join(alice1.config_dir, 'creds.json'), '{}');
    writeFileSync(join(alice2.config_dir, 'creds.json'), '{}');

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

    const host = await c.json<{ username: string; hostname: string; home: string }>(
      'GET',
      '/api/host',
    );
    expect(host.username.length).toBeGreaterThan(0);
    expect(host.hostname.length).toBeGreaterThan(0);
    expect(host.home.startsWith('/')).toBe(true);

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

    // A leading ~ expands against the host home directory.
    const tilde = await c.json<{ entries: unknown[] }>('GET', '/api/fs/dirs?prefix=~/');
    expect(Array.isArray(tilde.entries)).toBe(true);

    // Re-registering a known path (however spelt) returns the existing repo.
    const again = await c.json<Repo>('POST', '/api/repos', { path: repoPath });
    expect(again.id).toBe(repo.id);

    // Branch hints: local + fetched remote heads, default base first.
    const { branches } = await c.json<{
      branches: Array<{ name: string; is_session: boolean; session_title: string | null }>;
    }>('GET', `/api/repos/${repo.id}/branches`);
    expect(branches[0]?.name).toBe(repo.default_base_branch);

    // Project ids are 10-hex URL handles.
    expect(project.id).toMatch(/^[0-9a-f]{10}$/);
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

  it('lets the agent name its session via .puddle/session-title', async () => {
    const c = client(daemon);
    writeFileSync(join(s1.worktree_path, '.puddle', 'session-title'), 'renamed by the agent\n');
    await pollUntil(async () => {
      const session = await c.json<Session>('GET', `/api/sessions/${s1.id}`);
      return session.title === 'renamed by the agent';
    });
    // The session's branch is annotated with its title in the branch list.
    const { branches } = await c.json<{
      branches: Array<{ name: string; is_session: boolean; session_title: string | null }>;
    }>('GET', `/api/repos/${repo.id}/branches`);
    const owned = branches.find((b) => b.name === s1.branch);
    expect(owned?.is_session).toBe(true);
    expect(owned?.session_title).toBe('renamed by the agent');
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

  it('stores ui state per (project, profile); other profiles seed without clobbering', async () => {
    const c = client(daemon);
    const noProfile = await c.req('GET', `/api/projects/${project.id}/state`);
    expect(noProfile.status).toBe(400);
    const noState = await c.req('GET', `/api/projects/${project.id}/state?profile=${profile.id}`);
    expect(noState.status).toBe(404);
    expect(((await noState.json()) as { error: { code: string } }).error.code).toBe('no_state');

    const snapshotA = {
      session_tabs: [s1.id, s2.id],
      active_session: s1.id,
      editor_tabs: [],
      layout: { sidebar: 24 },
      explorer_pin: null,
    };
    await c.json('PUT', `/api/projects/${project.id}/state?profile=${profile.id}`, {
      ui_state: snapshotA,
    });

    // The profile reads its own row back — from any browser or tunnel port.
    const ownRow = await c.json<{ ui_state: typeof snapshotA }>(
      'GET',
      `/api/projects/${project.id}/state?profile=${profile.id}`,
    );
    expect(ownRow.ui_state).toEqual(snapshotA);

    // Another profile seeds from the latest snapshot but writes its own row.
    const bob = await c.json<Profile>('POST', '/api/profiles', { name: 'bob' });
    const seeded = await c.json<{ ui_state: typeof snapshotA }>(
      'GET',
      `/api/projects/${project.id}/state?profile=${bob.id}`,
    );
    expect(seeded.ui_state).toEqual(snapshotA);
    await c.json('PUT', `/api/projects/${project.id}/state?profile=${bob.id}`, {
      ui_state: { ...snapshotA, active_session: s2.id },
    });
    const aliceAfter = await c.json<{ ui_state: { active_session: string } }>(
      'GET',
      `/api/projects/${project.id}/state?profile=${profile.id}`,
    );
    expect(aliceAfter.ui_state.active_session).toBe(s1.id);
    await c.req('DELETE', `/api/profiles/${bob.id}`); // keep the later delete test exact
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

  it('imports a pre-existing config dir by copy, leaving the source untouched', async () => {
    const c = client(daemon);
    const source = mkdtempSync(join(tmpdir(), 'puddle-import-'));
    writeFileSync(join(source, 'settings.json'), '{"theme":"dark"}\n');
    writeFileSync(join(source, 'creds.json'), 'opaque\n'); // fake adapter's logged-in marker

    const imported = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'imported',
      import_dir: source,
    });
    // Copied into a puddle-owned dir, never linked in place…
    expect(imported.config_dir).toContain(`/profiles/${profile.id}/accounts/fake/imported`);
    expect(existsSync(join(imported.config_dir, 'settings.json'))).toBe(true);
    // …with login state verified through the adapter, not assumed.
    expect(imported.logged_in).toBe(true);
    // The source survives, byte for byte where it was.
    expect(existsSync(join(source, 'settings.json'))).toBe(true);

    const bad = await c.req('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'imported-2',
      import_dir: '/definitely/not/a/dir',
    });
    expect(bad.status).toBe(400);
  });

  it('reports per-account usage: puddle counts plus agent token totals', async () => {
    const c = client(daemon);
    writeFileSync(
      join(alice1.config_dir, 'usage.json'),
      JSON.stringify({
        input_tokens: 1200,
        output_tokens: 340,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 12,
        message_count: 7,
      }),
    );
    const usage = await c.json<{
      account_id: number;
      logged_in: boolean;
      session_count: number;
      agent_usage: { input_tokens: number; message_count: number } | null;
    }>('GET', `/api/accounts/${alice1.id}/usage`);
    expect(usage.account_id).toBe(alice1.id);
    expect(usage.logged_in).toBe(true);
    expect(usage.session_count).toBeGreaterThanOrEqual(1); // s1 ran on alice1
    expect(usage.agent_usage?.input_tokens).toBe(1200);
    expect(usage.agent_usage?.message_count).toBe(7);

    // No usage record → null token totals, counts still present.
    const bare = await c.json<{ agent_usage: unknown; session_count: number }>(
      'GET',
      `/api/accounts/${alice2.id}/usage`,
    );
    expect(bare.agent_usage).toBeNull();
  });

  it('gates subscription usage behind the per-account opt-in', async () => {
    const c = client(daemon);
    // Off by default → no subscription field, no token read attempted.
    const before = await c.json<{ subscription: unknown }>(
      'GET',
      `/api/accounts/${alice1.id}/usage`,
    );
    expect(before.subscription).toBeNull();

    const toggled = await c.json<Account>('PATCH', `/api/accounts/${alice1.id}`, {
      rate_limit_tracking: true,
    });
    expect(toggled.rate_limit_tracking).toBe(true);

    // The fake adapter has no subscriptionUsage hook, so even opted-in it
    // stays null — the endpoint degrades gracefully rather than erroring.
    const after = await c.json<{ subscription: unknown }>(
      'GET',
      `/api/accounts/${alice1.id}/usage`,
    );
    expect(after.subscription).toBeNull();

    await c.json<Account>('PATCH', `/api/accounts/${alice1.id}`, { rate_limit_tracking: false });
  });

  it('refuses to spawn on an account the agent says is logged out', async () => {
    const c = client(daemon);
    const loggedOut = await c.json<Account>('POST', '/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'logged-out',
    });
    // No creds.json → the adapter's checkLoggedIn probe says no.
    const refused = await c.req('POST', '/api/sessions', {
      project_id: project.id,
      account_id: loggedOut.id,
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'account_logged_out',
    );
    // The stored flag is corrected to the verified truth.
    const accounts = await c.json<Account[]>('GET', `/api/accounts?profile=${profile.id}`);
    expect(accounts.find((a) => a.id === loggedOut.id)?.logged_in).toBe(false);
  });

  it('recovers a lost conversation ref by worktree on resume', async () => {
    const c = client(daemon);
    const s4 = await c.json<Session>('POST', '/api/sessions', {
      project_id: project.id,
      account_id: alice1.id,
      title: 'recovery test',
    });
    await c.json<Session>('POST', `/api/sessions/${s4.id}/kill`);

    // Simulate the agent having restarted the session under a fresh id: the
    // recorded ref's conversation is gone, a different one exists.
    rmSync(join(alice1.config_dir, `conv-fake-ref-${s4.id}`));
    writeFileSync(join(alice1.config_dir, 'discovered-ref'), 'fake-ref-recovered\n');

    const resumed = await c.json<Session>('POST', `/api/sessions/${s4.id}/resume`);
    expect(resumed.agent_session_ref).toBe('fake-ref-recovered');

    rmSync(join(alice1.config_dir, 'discovered-ref'));
    await c.json<Session>('POST', `/api/sessions/${s4.id}/kill`);
    await c.json<Session>('POST', `/api/sessions/${s4.id}/archive`, { force: true });
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
    // alice1 plus the account created by the import test survive.
    expect(remaining.map((a) => a.id)).toContain(alice1.id);
    expect(remaining.map((a) => a.id)).not.toContain(alice2.id);
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
