import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reconcilePass } from '../src/sessions/reconcile.js';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';
import { sh } from './helpers/git-fixtures.js';

/** A config dir carrying the fake adapter's logged-in marker. */
function credsDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `puddle-cfg-${label}-`));
  writeFileSync(join(dir, 'creds.json'), '{}');
  return dir;
}

describe('SessionService.create', () => {
  it('creates worktree, injects the onboarding preamble, reaches waiting_input', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'fix latency',
      prompt: 'make it faster',
    });
    expect(session.status).toMatch(/starting|running/);
    expect(session.branch).toBe('alice/fix-latency');
    expect(session.agent_session_ref).toBe(`fake-ref-${session.id}`);
    expect(existsSync(session.worktree_path)).toBe(true);
    expect(sh(session.worktree_path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      'alice/fix-latency',
    );

    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('READY'));
    const output = f.logs.readTail(session.id, 'agent');
    expect(output).toContain('[puddle onboarding]');
    expect(output).toContain('always run make setup'); // repo notes injected
    expect(output).toContain('make it faster'); // user prompt appended
    expect(output).toContain('skip=false');

    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    const statuses = f.stores.events.list(session.id).map((e) => e.type);
    expect(statuses).toContain('created');
    await f.service.kill(session.id);
  });

  it('rejects skip_permissions against a closed gate with 400', async () => {
    const f = fixture();
    await expect(
      f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
        skip_permissions: true,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'skip_permissions_denied' });
  });

  it('honours skip_permissions when gate and account opt-in are both on', async () => {
    const f = fixture();
    f.stores.profiles.patchSettings(f.ids.profile, { allowSkipPermissions: true });
    const account2 = f.stores.accounts.create({
      profile_id: f.ids.profile,
      agent_type: 'fake',
      label: 'yolo',
      config_dir: credsDir('yolo'),
      skip_permissions_default: true,
    });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: account2.id,
      title: 'trusted',
      skip_permissions: true,
    });
    expect(session.skip_permissions).toBe(true);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('skip=true'));
    await f.service.kill(session.id);
  });

  it('rejects an account from another profile', async () => {
    const f = fixture();
    const bob = f.stores.profiles.create({ name: 'bob', branch_prefix: 'bob/' });
    const bobAccount = f.stores.accounts.create({
      profile_id: bob.id,
      agent_type: 'fake',
      label: 'personal',
      config_dir: '/tmp/bob-cfg',
      skip_permissions_default: false,
    });
    await expect(
      f.service.create({ project_id: f.ids.project, account_id: bobAccount.id }),
    ).rejects.toMatchObject({ code: 'foreign_account' });
  });
});

describe('kill / resume / archive lifecycle', () => {
  it('kill → exited; resume replays the ref; archive removes the worktree, keeps the branch', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'lifecycle',
    });
    await waitFor(() => f.service.get(session.id).status !== 'starting');
    const killed = await f.service.kill(session.id);
    expect(killed.status).toBe('exited');

    const resumed = await f.service.resume(session.id);
    expect(resumed.status).toBe('running');
    await waitFor(() =>
      f.logs.readTail(session.id, 'agent').includes(`RESUME ref=fake-ref-${session.id}`),
    );
    // resume of an exited (not interrupted) session carries no injected note
    expect(f.logs.readTail(session.id, 'agent')).toContain('PROMPT<<>>');

    await f.service.kill(session.id);
    const archived = await f.service.archive(session.id);
    expect(archived.status).toBe('archived');
    expect(existsSync(session.worktree_path)).toBe(false);
    expect(sh(f.repoPath, 'branch', '--list', 'alice/lifecycle')).toContain('alice/lifecycle');
    // logs retained
    expect(f.logs.readTail(session.id, 'agent')).not.toBe('');
  });

  it('injects the interrupted note when resuming an interrupted session', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'interrupted',
    });
    await f.service.kill(session.id);
    f.stores.sessions.setStatus(session.id, 'interrupted'); // simulate reconcile
    await f.service.resume(session.id);
    await waitFor(() =>
      f.logs.readTail(session.id, 'agent').includes('This session was interrupted'),
    );
    await f.service.kill(session.id);
  });

  it('downgrades skip on resume when the gate closed, with a terminal note', async () => {
    const f = fixture();
    f.stores.profiles.patchSettings(f.ids.profile, { allowSkipPermissions: true });
    const account = f.stores.accounts.create({
      profile_id: f.ids.profile,
      agent_type: 'fake',
      label: 'yolo2',
      config_dir: credsDir('yolo2'),
      skip_permissions_default: true,
    });
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: account.id,
      title: 'gated',
      skip_permissions: true,
    });
    await f.service.kill(session.id);
    f.stores.profiles.patchSettings(f.ids.profile, { allowSkipPermissions: false }); // gate closes
    const resumed = await f.service.resume(session.id);
    expect(resumed.skip_permissions).toBe(false);
    await waitFor(() => f.logs.readTail(session.id, 'agent').includes('skip=false'));
    expect(f.logs.readTail(session.id, 'agent')).toContain('skip-permissions no longer permitted');
    await f.service.kill(session.id);
  });

  it('refuses to archive a live session', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'live',
    });
    await expect(f.service.archive(session.id)).rejects.toMatchObject({ code: 'session_live' });
    await f.service.kill(session.id);
  });

  it('refuses to archive a dirty worktree without force', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'dirty',
    });
    await f.service.kill(session.id);
    writeFileSync(join(session.worktree_path, 'uncommitted.txt'), 'x');
    await expect(f.service.archive(session.id)).rejects.toMatchObject({ code: 'worktree_dirty' });
    const archived = await f.service.archive(session.id, true);
    expect(archived.status).toBe('archived');
  });

  it('archiveProject refuses live sessions unless forced', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'proj',
    });
    await expect(f.service.archiveProject(f.ids.project)).rejects.toMatchObject({
      code: 'project_live',
    });
    await f.service.archiveProject(f.ids.project, true);
    expect(f.service.get(session.id).status).toBe('archived');
  });
});

describe('shells', () => {
  it('spawns numbered shells in the worktree', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'shells',
    });
    const term = f.service.spawnShell(session.id);
    expect(term).toBe('shell-1');
    f.ptys.write(session.id, term, 'pwd\n');
    await waitFor(() => f.logs.readTail(session.id, term).includes(session.worktree_path));
    expect(f.service.spawnShell(session.id)).toBe('shell-2');
    await f.service.kill(session.id);
  });
});

describe('reconcile', () => {
  it('marks live-status sessions interrupted on boot', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'reconcile',
    });
    await f.service.kill(session.id);
    f.stores.sessions.setStatus(session.id, 'running'); // pretend the daemon died mid-flight
    const result = reconcilePass({
      sessions: f.stores.sessions,
      events: f.stores.events,
      projects: f.stores.projects,
      onboarding: f.onboarding,
    });
    expect(result.interrupted).toEqual([session.id]);
    expect(f.service.get(session.id).status).toBe('interrupted');
    expect(f.stores.events.list(session.id).map((e) => e.type)).toContain('interrupted');
  });
});

describe('onboarding notes sync', () => {
  it('syncs .puddle/onboarding-notes.md into repos.onboarding_notes with a previous-notes event', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'notes',
    });
    writeFileSync(
      join(session.worktree_path, '.puddle', 'onboarding-notes.md'),
      'always run make setup\nnever install playwright browsers\n',
    );
    await waitFor(() =>
      (f.stores.repos.get(f.ids.repo).onboarding_notes ?? '').includes('playwright'),
    );
    const events = f.stores.events.list(session.id);
    const sync = events.find((e) => e.type === 'onboarding_notes_updated');
    expect(sync?.payload).toEqual({ previous: 'always run make setup' });
    await f.service.kill(session.id);
  });
});
