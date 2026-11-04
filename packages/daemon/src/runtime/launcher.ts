import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUNTIME_LIMITS,
  RUNTIME_PROTOCOL_VERSION,
  runtimeLaunchSchema,
  runtimeStateSchema,
  type RuntimeCommand,
  type RuntimeLaunch,
  type RuntimeProviderLaunch,
  type RuntimeSupervisor,
  type RuntimeTheme,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../compilation/process.js';
import type { RuntimeStore } from '../db/stores/runtimes.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { ProjectStore } from '../db/stores/projects.js';
import type { ProfileStore } from '../db/stores/profiles.js';
import { ApiError } from '../http/errors.js';
import { acquireRuntimeClaim } from './claims.js';
import type { RuntimeConnections } from './connections.js';
import type { RuntimeReconciler } from './reconcile.js';
import { runtimeDirectory, readRuntimeJson } from './storage.js';
import { startRuntimeService } from './supervisor.js';
import { pinRuntimeShellHooks } from './shell-hooks.js';
import type { ShellHooks } from '../pty/shell-hooks.js';
import type { ProgrammeOperation } from '../puddlang/runtime-turn-store.js';

interface LaunchOptions {
  provider?: RuntimeProviderLaunch;
  codeRunDirectory?: string;
  programme?: ProgrammeOperation;
}

/** Explicit composition option until installed release selection and rollout gates exist. */
export interface RuntimeLaunchConfiguration {
  kind: RuntimeSupervisor['kind'];
  nodePath: string;
  entryPath: string;
  releasePath: string;
  build: string;
  /** Supervisor command runner; isolated integration tests supply a fake supervisor. */
  run?: CompilationCommandRunner;
}

interface Dependencies {
  home: string;
  environment: Record<string, string>;
  runtimes: RuntimeStore;
  sessions: SessionStore;
  projects: ProjectStore;
  profiles: ProfileStore;
  connections: RuntimeConnections;
  reconciler: RuntimeReconciler;
  theme?: () => RuntimeTheme | null;
}

/** Persist one launch intent, dispatch once, then observe authenticated adoption. */
export class RuntimeLauncher {
  private closed = false;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly deps: Dependencies,
    private readonly configuration: RuntimeLaunchConfiguration,
  ) {}

  launch(
    sessionId: string,
    command: (hooks: ShellHooks) => RuntimeCommand,
    options: LaunchOptions = {},
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Runtime launcher is closing'));
    if (this.pending.size >= RUNTIME_LIMITS.pendingRequests)
      return Promise.reject(ApiError.conflict('runtime_busy', 'Too many pending runtime launches'));
    const pending = this.start(sessionId, command, options);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  private async start(
    sessionId: string,
    command: (hooks: ShellHooks) => RuntimeCommand,
    { provider, codeRunDirectory, programme }: LaunchOptions,
  ): Promise<void> {
    const session = this.deps.sessions.get(sessionId);
    if (this.deps.runtimes.ownerOf(sessionId))
      throw ApiError.conflict('runtime_owned', 'This placement already has an independent owner');
    const project = this.deps.projects.get(session.project_id);
    // Pin selectors before writing intent. Updating a default cannot change this launch.
    const config = {
      ...this.configuration,
      nodePath: realpathSync(this.configuration.nodePath),
      entryPath: realpathSync(this.configuration.entryPath),
      releasePath: realpathSync(this.configuration.releasePath),
    };
    const identity = {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: project.profile_id,
      project_id: project.id,
      session_id: sessionId,
      canonical_worktree_path: realpathSync(session.worktree_path),
    };
    const claim = acquireRuntimeClaim(this.deps.home, `runtime-launch:${identity.runtime_id}`);
    try {
      const directory = runtimeDirectory(this.deps.home, identity.runtime_id);
      const launch: RuntimeLaunch = runtimeLaunchSchema.parse({
        format: 1,
        identity,
        secret: randomBytes(32).toString('hex'),
        main: command(pinRuntimeShellHooks(directory)),
        environment: this.deps.environment,
        shell_hooks: true,
        provider,
        theme: this.deps.theme?.() ?? undefined,
        capture_env: {
          enabled: this.deps.profiles.getSettings(project.profile_id).captureSessionEnv,
          values: this.deps.sessions.getEnv(sessionId),
        },
      });
      if ((provider?.resume_ref ?? provider?.initial_ref ?? null) !== session.agent_session_ref)
        throw new Error('Runtime launch conversation does not match its placement');
      if (Buffer.byteLength(JSON.stringify(launch)) > RUNTIME_LIMITS.frameBytes)
        throw new Error('Runtime launch context exceeds its private record limit');
      atomicPrivateJson(join(directory, 'launch.json'), launch);
      this.deps.runtimes.prepare({
        identity,
        build: config.build,
        protocol: RUNTIME_PROTOCOL_VERSION,
        releasePath: config.releasePath,
        programme,
        ...(codeRunDirectory === undefined
          ? {}
          : { codeRunDirectory: realpathSync(codeRunDirectory) }),
      });
      // After this point an uncertain response must preserve intent and never try
      // another backend. The same launch claim also prevents premature retirement.
      try {
        await startRuntimeService(this.deps.home, identity, config);
      } catch {
        // A supervisor may have accepted the job before its reply was lost.
      }
      const deadline = Date.now() + 15_000;
      let delay = 50;
      while (!this.closed) {
        await this.deps.connections.connect();
        const binding = this.deps.runtimes.get(identity.runtime_id);
        const client = this.deps.connections.get(identity.runtime_id);
        if (
          binding?.state === 'running' &&
          client?.state?.binding?.session_id === binding.active_session_id &&
          client.state.binding.segment_id === binding.active_segment_id &&
          !this.deps.reconciler.pendingIds().includes(identity.runtime_id) &&
          this.deps.runtimes.terminalForPlacement(binding.active_session_id, 'agent')
        )
          return;
        if (binding?.state === 'exited') return;
        if (binding?.state === 'failed')
          throw ApiError.conflict(
            'runtime_launch_failed',
            'The runtime exited before completing launch. Its command was not replayed.',
          );
        if (!client) {
          try {
            const final = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
            if (
              ['exited', 'failed'].includes(final.state) &&
              Object.entries(identity).every(
                ([key, value]) => final.identity[key as keyof typeof identity] === value,
              )
            ) {
              // A terminal record is only a reason to attempt exclusive retirement;
              // the owner claim still decides whether its process has really gone.
              claim.release();
            }
          } catch {
            /* Missing/incomplete records keep launch ownership protected. */
          }
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 1000);
      }
      throw ApiError.conflict(
        'runtime_launch_unconfirmed',
        'The runtime launch is recorded but readiness is unconfirmed. Reconnect to inspect it; the command has not been replayed.',
      );
    } finally {
      claim.release();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
