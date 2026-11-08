import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { vi } from 'vitest';
import { runtimeSupervisorSchema, type HuddleRuntimeCapabilities } from '@puddle/shared';
import { runtimeDatabase } from '../runtime-database.js';
import { bundleDir, children, environment } from '../runtime-fixture.js';
import { huddleTurnScope } from './agent-turns.js';
import { sh } from '../git-fixtures.js';
import { runtimeTestAdapter } from '../runtime-test-adapter.js';
import { HuddleSpawnStore } from '../../../src/huddle/operations/spawns/store.js';
import { HuddleAgentSpawns } from '../../../src/huddle/operations/spawns/service.js';
import { SessionService } from '../../../src/sessions/service.js';
import { AdapterRegistry } from '../../../src/agents/registry.js';
import { AccountStore } from '../../../src/db/stores/accounts.js';
import { RepoStore } from '../../../src/db/stores/repos.js';
import { ProjectStore } from '../../../src/db/stores/projects.js';
import { ProgrammeTurnStore } from '../../../src/puddlang/runtime-turn-store.js';
import { RuntimeProgrammeTurns } from '../../../src/runtime/controller/programme-turns.js';
import { RuntimeConnections } from '../../../src/runtime/transport/connections.js';
import { RuntimeControls } from '../../../src/runtime/controller/controls.js';
import { RuntimeLauncher } from '../../../src/runtime/lifecycle/launcher.js';
import { readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { LogStore } from '../../../src/logs/log-store.js';
import { PtyManager } from '../../../src/pty/pty-manager.js';
import { MarkerFileSync } from '../../../src/sessions/onboarding.js';
import { WorktreeManager } from '../../../src/worktrees/manager.js';
import { KeyedMutex } from '../../../src/git/mutex.js';
import type { CompilationCommandRunner } from '../../../src/compilation/process.js';

/** Real session/launcher/agent processes; a synthetic source huddle supplies private caller authority. */
export function huddleSpawnServiceFixture(
  timeout = 120_000,
  capabilities?: HuddleRuntimeCapabilities,
) {
  const f = runtimeDatabase('headless');
  f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
    f.sessions.setStatus(f.session.id, 'exited'),
  );
  const { target: _, ...scope } = huddleTurnScope(f, capabilities);
  sh(f.home, 'init', '-b', 'main');
  const accounts = new AccountStore(f.db);
  accounts.setLoggedIn(f.account!.id, true);
  const repos = new RepoStore(f.db),
    projects = new ProjectStore(f.db);
  const adapters = new AdapterRegistry([runtimeTestAdapter]);
  const connections = new RuntimeConnections(
    f.home,
    f.runtimes,
    {
      connected: (id, client) => f.reconciler.attach(id, client),
      missing: (id) => f.reconciler.retire(id),
      huddleConnected: (id, client) => f.reconciler.attachHuddle(id, client),
      huddleMissing: (id) => f.reconciler.retire(id),
    },
    f.controller,
  );
  const controls = new RuntimeControls(f.runtimes, connections, f.reconciler);
  const run = vi.fn<CompilationCommandRunner>(async (command) => {
    const record = runtimeSupervisorSchema.parse(
      readRuntimeJson(join(dirname(command.args[2]!), 'supervisor.json')),
    );
    const child = spawn(
      record.node_path,
      [record.entry_path, '--home', f.home, '--runtime', record.identity.runtime_id],
      { env: environment(f.home), detached: true, stdio: 'ignore' },
    );
    children.push(child);
    await once(child, 'spawn');
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const launcher = new RuntimeLauncher(
    { ...f, connections, projects, environment: environment(f.home) as Record<string, string> },
    {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath: join(bundleDir, 'provider-owner.mjs'),
      releasePath: bundleDir,
      build: 'runtime-test',
      run,
    },
  );
  const turns = new RuntimeProgrammeTurns(
    f.runtimes,
    connections,
    f.reconciler,
    new ProgrammeTurnStore(f.db),
  );
  const logs = new LogStore(f.paths.logsDir, 256 * 1024);
  const ptys = new PtyManager(logs);
  const onboarding = new MarkerFileSync({ repos, sessions: f.sessions, events: f.events });
  const worktrees = new WorktreeManager({
    paths: f.paths,
    repos,
    sessions: f.sessions,
    runtimes: f.runtimes,
    mutex: new KeyedMutex(),
  });
  const service = new SessionService({
    ...f,
    accounts,
    repos,
    projects,
    adapters,
    worktrees,
    logs,
    ptys,
    onboarding,
    runtimeLauncher: launcher,
    runtimeControls: controls,
    runtimeProgrammeTurns: turns,
  });
  const store = new HuddleSpawnStore(f.db);
  const deps = { store, service, adapters, runtimes: f.runtimes, turns, connections, controls };
  const spawns = new HuddleAgentSpawns(deps, timeout);
  const request = {
    projectId: f.project.id,
    worktree: f.launch.identity.canonical_worktree_path,
    accountId: f.account!.id,
    agent: 'runtime-test',
    mode: 'headless' as const,
    title: 'Created by huddle',
  };
  return {
    ...f,
    scope,
    request,
    spawns,
    deps,
    store,
    service,
    controls,
    connections,
    run,
    async close() {
      service.beginShutdown();
      onboarding.dispose();
      ptys.killAll();
      await launcher.close();
      await controls.close();
      await connections.close();
      await f.reconciler.close();
      f.db.close();
    },
  };
}
