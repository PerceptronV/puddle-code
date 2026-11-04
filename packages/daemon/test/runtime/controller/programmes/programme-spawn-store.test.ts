import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { puddlangStartSchema, RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { PuddlangStore } from '../../../../src/puddlang/store.js';
import { ProjectStore } from '../../../../src/db/stores/projects.js';
import { reconcilePass } from '../../../../src/sessions/reconcile.js';
import type { MarkerFileSync } from '../../../../src/sessions/onboarding.js';
import { runtimeDatabase } from '../../../helpers/runtime-database.js';

it('atomically records programme placements and fences cancelled or duplicate launches', async () => {
  const f = runtimeDatabase('headless');
  try {
    const runs = new PuddlangStore(f.db);
    const run = runs.create(
      f.profile.id,
      puddlangStartSchema.parse({ id: randomUUID(), source: 'export default null;' }),
    ).run;
    const scope = { runId: run.id, operationId: 1, profileId: f.profile.id };
    const row = {
      id: randomUUID(),
      project_id: f.project.id,
      account_id: f.account!.id,
      worktree_path: f.home,
      base_branch: 'main',
      branch: 'main',
      separate_branch: false,
      kind: 'agent' as const,
      agent_type: 'runtime-test',
      title: null,
      skip_permissions: false,
      agent_mode: 'headless' as const,
    };
    f.db.exec(
      "CREATE TRIGGER fail_spawn_record BEFORE INSERT ON puddlang_runtime_spawns BEGIN SELECT RAISE(ABORT, 'spawn storage unavailable'); END",
    );
    expect(() => f.sessions.create(row, scope)).toThrow('spawn storage unavailable');
    expect(() => f.sessions.get(row.id)).toThrow();
    f.db.exec('DROP TRIGGER fail_spawn_record');
    f.sessions.create(row, scope);
    expect(runs.spawns.list(f.profile.id, run.id)).toMatchObject([
      { session_id: row.id, runtime_id: null },
    ]);
    const duplicate = { ...row, id: randomUUID() };
    expect(() => f.sessions.create(duplicate, scope)).toThrow();
    expect(() => f.sessions.get(duplicate.id)).toThrow();
    runs.spawns.requestStop(f.profile.id, run.id);
    const launch = {
      identity: {
        ...f.launch.identity,
        session_id: row.id,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
      },
      build: 'test',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.directory,
      programme: scope,
    };
    expect(() => f.runtimes.prepare(launch)).toThrow('cancelled');
    expect(f.runtimes.get(launch.identity.runtime_id)).toBeNull();
    const fresh = { ...row, id: randomUUID() };
    expect(() => f.sessions.create(fresh, { ...scope, operationId: 2 })).toThrow();
    expect(() => f.sessions.get(fresh.id)).toThrow();
    const reconciled = reconcilePass({
      ...f,
      projects: new ProjectStore(f.db),
      onboarding: { watch: vi.fn() } as unknown as MarkerFileSync,
    });
    expect(f.sessions.get(row.id).status).toBe('interrupted');
    expect(reconciled.interrupted).not.toContain(row.id); // Never execute an unstarted programme spawn on boot.
    // A later explicit legacy resume is ordinary session recovery, not the old spawn.
    f.runtimes.useLegacyTerminals(row.id);
    expect(f.runtimes.unstartedProgrammeSessions().has(row.id)).toBe(false);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});

it('keeps programme ownership on its original runtime when the placement is explicitly resumed', async () => {
  const f = runtimeDatabase('headless');
  try {
    const runs = new PuddlangStore(f.db);
    const run = runs.create(
      f.profile.id,
      puddlangStartSchema.parse({ id: randomUUID(), source: 'export default null;' }),
    ).run;
    const scope = { runId: run.id, operationId: 1, profileId: f.profile.id };
    f.runtimes.finish(f.binding.runtime_id, 'exited', () => {});
    runs.spawns.record(scope, f.session.id);
    const launch = {
      identity: {
        ...f.launch.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
      },
      build: 'test',
      protocol: RUNTIME_PROTOCOL_VERSION,
      releasePath: f.directory,
    };
    const original = f.runtimes.prepare({ ...launch, programme: scope });
    f.runtimes.finish(original.runtime_id, 'exited', () => {});
    const replacement = f.runtimes.prepare({
      ...launch,
      identity: {
        ...launch.identity,
        runtime_id: randomUUID(),
        incarnation: randomUUID(),
        launch_id: randomUUID(),
      },
    });
    expect(runs.spawns.list(f.profile.id, run.id)).toMatchObject([
      { runtime_id: original.runtime_id },
    ]);
    expect(f.runtimes.selectedOwner(f.session.id)?.runtime_id).toBe(replacement.runtime_id);
  } finally {
    await f.reconciler.close();
    f.db.close();
  }
});
