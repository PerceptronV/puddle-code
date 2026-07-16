import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('kill → exited; resume replays the ref; archive is a reversible hide (worktree kept)', async () => {
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
    // Archive keeps the worktree, branch, and logs — nothing is destroyed.
    const archived = await f.service.archive(session.id);
    expect(archived.status).toBe('archived');
    expect(existsSync(session.worktree_path)).toBe(true);
    expect(sh(f.repoPath, 'branch', '--list', 'alice/lifecycle')).toContain('alice/lifecycle');
    expect(f.logs.readTail(session.id, 'agent')).not.toBe('');

    // Unarchive brings it back resumable while the worktree survives.
    const unarchived = await f.service.unarchive(session.id);
    expect(unarchived.status).toBe('exited');
    expect(unarchived.worktree_missing).toBeUndefined();
    const reresumed = await f.service.resume(session.id);
    expect(reresumed.status).toBe('running');
    await f.service.kill(session.id);
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

  it('archives a dirty worktree without complaint, keeping its uncommitted changes', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'dirty',
    });
    await f.service.kill(session.id);
    writeFileSync(join(session.worktree_path, 'uncommitted.txt'), 'x');
    // Archive no longer removes the worktree, so a dirty tree is safe — no force,
    // no prompt, and the uncommitted file survives.
    const archived = await f.service.archive(session.id);
    expect(archived.status).toBe('archived');
    expect(existsSync(join(session.worktree_path, 'uncommitted.txt'))).toBe(true);
  });

  it('unarchive of a session whose worktree is gone returns it for history only', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      title: 'gone',
    });
    await f.service.kill(session.id);
    await f.service.archive(session.id);
    // The worktree is pruned out-of-band (e.g. via the Worktrees manager).
    rmSync(session.worktree_path, { recursive: true, force: true });
    const unarchived = await f.service.unarchive(session.id);
    expect(unarchived.status).toBe('exited');
    expect(unarchived.worktree_missing).toBe(true);
    // Resume is refused — there is no worktree to run in (history only).
    await expect(f.service.resume(session.id)).rejects.toMatchObject({ code: 'worktree_missing' });
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

describe('session naming', () => {
  it("adopts the agent's own name as agent_title and broadcasts the change", async () => {
    const f = fixture();
    const renames: Array<{ title: string | null; agent_title: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    // The fake agent names its session; the daemon picks it up on the next
    // status change (the waiting_input flip carries a quiet window, so the file
    // is in place by the time the refresh runs).
    const cfg = f.stores.accounts.get(f.ids.account).config_dir;
    writeFileSync(join(cfg, `title-${session.agent_session_ref}`), 'named by the agent');
    await waitFor(() => f.service.get(session.id).agent_title === 'named by the agent');
    expect(f.service.get(session.id).title).toBeNull(); // no user override
    expect(renames.some((e) => e.agent_title === 'named by the agent')).toBe(true);
    await f.service.kill(session.id);
  });

  it('re-reads the agent name on an OSC title emission, without a status change', async () => {
    const f = fixture();
    const renames: Array<{ agent_title: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    // Settle into a steady live state (READY → waiting_input) with no name yet.
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    expect(f.service.get(session.id).agent_title).toBeNull();

    // The agent renames itself mid-session — as Claude Code's `/rename` does,
    // entirely client-side: it rewrites its own title source and sets the
    // terminal title, with no status transition. The OSC title reaching the PTY
    // stream is the only signal the daemon gets.
    const cfg = f.stores.accounts.get(f.ids.account).config_dir;
    writeFileSync(join(cfg, `title-${session.agent_session_ref}`), 'renamed live');
    f.ptys.emit('data', {
      stream: session.id,
      term: 'agent',
      data: '\u001b]0;⠻ renamed live\u0007',
    });

    await waitFor(() => f.service.get(session.id).agent_title === 'renamed live');
    expect(f.service.get(session.id).title).toBeNull(); // still no user override
    expect(renames.some((e) => e.agent_title === 'renamed live')).toBe(true);
    await f.service.kill(session.id);
  });

  it('picks up an idle in-agent rename via the periodic re-read (no OSC, no status change)', async () => {
    const f = fixture({ titleRefreshMs: 20 });
    const renames: Array<{ agent_title: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    expect(f.service.get(session.id).agent_title).toBeNull();

    // The agent renames itself while idle — no OSC escape, no status change. Only
    // the periodic re-read can catch this (the reliable path for claude-code's
    // `/rename`).
    const cfg = f.stores.accounts.get(f.ids.account).config_dir;
    writeFileSync(join(cfg, `title-${session.agent_session_ref}`), 'renamed while idle');
    await waitFor(() => f.service.get(session.id).agent_title === 'renamed while idle');
    expect(renames.some((e) => e.agent_title === 'renamed while idle')).toBe(true);
    await f.service.kill(session.id);
  });

  it('captures the terminal-title "sequence" name (osc_title) and de-animates it', async () => {
    const f = fixture();
    const renames: Array<{ osc_title?: string | null }> = [];
    f.service.on('renamed', (e) => renames.push(e));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
      prompt: 'go',
    });
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    expect(f.service.get(session.id).osc_title ?? null).toBeNull();

    // The process sets its terminal title with an animated spinner prefix. The
    // daemon stores the de-animated name; successive spinner frames of the same
    // name are one stored value and one broadcast, not one per frame.
    f.ptys.emit('data', {
      stream: session.id,
      term: 'agent',
      data: '\u001b]0;⠋ my terminal\u0007',
    });
    await waitFor(() => f.service.get(session.id).osc_title === 'my terminal');
    f.ptys.emit('data', {
      stream: session.id,
      term: 'agent',
      data: '\u001b]0;⠙ my terminal\u0007',
    });
    expect(renames.filter((e) => e.osc_title === 'my terminal')).toHaveLength(1);
    await f.service.kill(session.id);
  });

  it('rename stores a user override; an empty rename clears it back to the default', async () => {
    const f = fixture();
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    f.service.rename(session.id, 'my session');
    expect(f.service.get(session.id).title).toBe('my session');
    // Empty (or whitespace) clears the override so the name reverts to
    // agent_title (then the id prefix).
    f.service.rename(session.id, '   ');
    expect(f.service.get(session.id).title).toBeNull();
    await f.service.kill(session.id);
  });
});
