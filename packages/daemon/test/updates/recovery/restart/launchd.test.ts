import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { hostUpdateActionsSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { updateRecoveryDirectory } from '@puddle/shared/node/host-control';
import { serviceDefinitionDigest } from '../../../../src/host/supervision/definition.js';
import { acquireHostClaim } from '../../../../src/security/claims.js';
import { DATABASE_SCHEMA_VERSION } from '../../../../src/db/migrations/index.js';
import { startUpdateRecoveryWorker } from '../../../../src/updates/recovery/worker/supervisor.js';
import { executeUpdateRecovery } from '../../../../src/updates/recovery/worker/execute.js';
import { restartRecoveryFixture } from '../../../helpers/update-restart-recovery.js';

async function fixture() {
  const f = await restartRecoveryFixture();
  const domain = `gui/${process.getuid!()}`;
  const name = 'dev.puddle.puddled';
  const path = join(f.home, 'daemon.plist');
  const plist = { Label: name, ProgramArguments: [join(f.home, 'bin/current/puddled')] };
  writeFileSync(path, JSON.stringify(plist), { mode: 0o600 });
  const state = { loaded: true, started: false, lost: false, afterUnload: () => {} };
  const mutations: string[] = [];
  const run = async (command: Parameters<typeof f.run>[0]) => {
    let stdout = '';
    if (command.file === '/usr/bin/plutil') stdout = JSON.stringify(plist);
    else if (command.args[0] === 'managername') stdout = 'Aqua';
    else if (command.args[0] === 'manageruid') stdout = String(process.getuid!());
    else if (command.args[0] === 'list')
      stdout = `${state.started ? process.pid : '-'}\t0\t${name}\n`;
    else if (command.args[0] === 'print' && !state.loaded)
      return { exitCode: 113, stdout, stderr: '' };
    else if (command.args[0] === 'bootout') {
      expect(() => acquireHostClaim(f.home, 'daemon-controller')).toThrow('owns this host claim');
      mutations.push('bootout');
      state.loaded = false;
      state.afterUnload();
      if (state.lost) throw new Error('Bootout reply lost');
    } else if (command.args[0] === 'bootstrap') {
      acquireHostClaim(f.home, 'daemon-controller').release();
      mutations.push('bootstrap');
      state.loaded = true;
      state.started = true;
    }
    return { exitCode: 0, stdout, stderr: '' };
  };
  f.job.kind = 'launchd';
  f.job.domain = domain;
  f.job.name = 'dev.puddle.update.fixture';
  f.job.daemon_service = {
    ...f.job.daemon_service!,
    kind: 'launchd',
    domain,
    name,
    invocation: null,
    controlGroup: null,
    definition_path: path,
    definition_digest: await serviceDefinitionDigest(
      f.home,
      { kind: 'launchd', domain, name },
      path,
      run,
    ),
  };
  atomicPrivateJson(join(f.directory, 'worker.json'), f.job);
  const options = {
    ...f.options,
    run: async (command: Parameters<typeof run>[0]) =>
      command.args[0] === 'bootstrap' ? f.supervisor(command) : run(command),
  };
  return { ...f, state, mutations, run, options, path };
}

it('retains controller exclusion and durable start intent while reloading an idle replacement', async () => {
  const f = await fixture();
  const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
  expect(job.daemon_restart).toBeDefined();
  expect(f.mutations).toEqual([]);
  f.state.afterUnload = () => {
    const journal = hostUpdateActionsSchema.parse(
      JSON.parse(
        readFileSync(
          join(updateRecoveryDirectory(f.home, job.operation_id), job.id, 'actions.json'),
          'utf8',
        ),
      ),
    );
    expect(journal.actions.find(({ action }) => action === 'start-daemon')?.state).toBe('started');
  };
  await executeUpdateRecovery(f.home, job, f.run);
  expect(f.mutations).toEqual(['bootout', 'bootstrap']);
  expect(f.store.read()?.phase).toBe('complete');
  await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow('already consumed');
});

it.each(['lost-reply', 'new-schema', 'configuration'] as const)(
  'does not start after unloading an idle replacement with %s uncertainty',
  async (failure) => {
    const f = await fixture();
    const job = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
    f.state.lost = failure === 'lost-reply';
    f.state.afterUnload = () => {
      if (failure === 'configuration') writeFileSync(f.path, 'changed definition');
      if (failure === 'new-schema') {
        const db = new Database(f.dbFile);
        db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION + 1}`);
        db.close();
      }
    };
    await expect(executeUpdateRecovery(f.home, job, f.run)).rejects.toThrow();
    expect(f.mutations).toEqual(['bootout']);
    expect(f.store.read()?.phase).toBe('recovery_required');
    if (failure === 'lost-reply') {
      f.state.lost = false;
      const next = await startUpdateRecoveryWorker(f.home, f.store.read()!, f.options);
      await executeUpdateRecovery(f.home, next, f.run);
      expect(f.mutations).toEqual(['bootout', 'bootstrap']);
      expect(f.store.read()?.phase).toBe('complete');
    }
  },
);
