import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runtimeStateSchema, sessionSchema } from '@puddle/shared';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { launchOwner, retainRuntimeHome, terminal } from '../../helpers/runtime-fixture.js';
import { sh } from '../../helpers/git-fixtures.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';

it('migrates a live independent provider only after its owner, shell and sidecar exit, preserving its exact transcript', async () => {
  const f = runtimeDatabase('interactive');
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
  const request = async (path: string, body: object = {}) => {
    const response = await fetch(`http://127.0.0.1:${ready!.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const value: unknown = await response.json();
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const state = (id: string) =>
    runtimeStateSchema.parse(readRuntimeJson(join(runtimeDirectory(f.home, id), 'state.json')));
  const ended = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  };
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    await f.reconciler.close();
    f.controller.release();
    sh(f.home, 'init', '-b', 'main');
    writeFileSync(join(f.home, 'test-enable-runtime-launcher'), '');
    const accounts = new AccountStore(f.db);
    const createAccount = (label: string) => {
      const directory = join(f.home, label);
      mkdirSync(directory, { mode: 0o700 });
      const account = accounts.create({
        profile_id: f.profile.id,
        agent_type: 'runtime-migration-test',
        label,
        config_dir: directory,
        skip_permissions_default: false,
      });
      accounts.setLoggedIn(account.id, true);
      return accounts.get(account.id);
    };
    const source = createAccount('source');
    const target = createAccount('target');
    daemon = launchOwner(f.home, f.binding.runtime_id, 'daemon-owner.mjs');
    await waitFor(() => {
      if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
      try {
        ready = readRuntimeJson(join(f.home, 'test-daemon-ready.json')) as typeof ready;
        return true;
      } catch {
        return false;
      }
    });
    const session = sessionSchema.parse(
      await request('/api/sessions', {
        project_id: f.project.id,
        account_id: source.id,
        separate_branch: false,
        separate_worktree: false,
      }),
    );
    const original = f.runtimes.ownerOf(session.id)!;
    const oldShell = terminal(state(original.runtime_id)).pid!;
    const oldOwner = (
      readRuntimeJson(
        join(runtimeDirectory(f.home, original.runtime_id), 'test-supervisor-pid.json'),
      ) as { pid: number }
    ).pid;
    const oldSidecar = (
      readRuntimeJson(join(source.config_dir, `${session.id}.signals.json`)) as { pid: number }
    ).pid;
    const migrated = sessionSchema.parse(
      await request(`/api/sessions/${session.id}/migrate`, { account_id: target.id }),
    );
    expect(migrated).toMatchObject({
      id: session.id,
      account_id: target.id,
      agent_session_ref: session.id,
      conversation_id: session.conversation_id,
      worktree_path: session.worktree_path,
      branch: session.branch,
    });
    expect(f.runtimes.get(original.runtime_id)?.state).toBe('exited');
    await waitFor(() => [oldOwner, oldShell, oldSidecar].every(ended));
    const replacement = f.runtimes.ownerOf(session.id)!;
    expect(replacement.runtime_id).not.toBe(original.runtime_id);
    expect(replacement.account_id).toBe(target.id);
    expect(terminal(state(replacement.runtime_id)).pid).not.toBe(oldShell);
    expect(readRuntimeJson(join(target.config_dir, `${session.id}.migration.json`))).toEqual({
      ref: session.id,
      resumed: true,
    });
    expect(readRuntimeJson(join(target.config_dir, `${session.id}.conversation.json`))).toEqual({
      ref: session.id,
      transcript: 'preserved',
    });
    expect(
      readRuntimeJson(join(runtimeDirectory(f.home, replacement.runtime_id), 'launch.json')),
    ).toMatchObject({
      provider: { config_dir: target.config_dir, resume_ref: session.id },
    });
    expect(f.events.list(session.id).filter(({ type }) => type === 'migrated')).toHaveLength(1);
    await request(`/api/sessions/${session.id}/kill`);
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const owner of f.runtimes.releaseReferences()) {
      try {
        const path = join(runtimeDirectory(f.home, owner.runtime_id), 'test-supervisor-pid.json');
        if (!existsSync(path)) continue; // The fixture's initial binding was never dispatched.
        const { pid } = readRuntimeJson(path) as { pid: number };
        if (!ended(pid)) process.kill(pid, 'SIGTERM');
        await waitFor(() => ended(pid));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') cleanupErrors.push(error);
      }
    }
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) {
      const exit = once(daemon.child, 'exit');
      daemon.child.kill('SIGTERM');
      await exit;
    }
    await f.reconciler.close();
    f.db.close();
    if (cleanupErrors.length) {
      retainRuntimeHome(f.home);
      // eslint-disable-next-line no-unsafe-finally -- Keep fixture data when process cleanup is unconfirmed.
      throw new AggregateError(cleanupErrors, `Migration fixture cleanup unconfirmed: ${f.home}`);
    }
  }
}, 60_000);
