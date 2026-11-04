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
import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import type { SessionStore } from '../../db/stores/sessions.js';
import type { ProjectStore } from '../../db/stores/projects.js';
import type { ProfileStore } from '../../db/stores/profiles.js';
import { ApiError } from '../../http/errors.js';
import { HostAdmission } from '../../host/lifecycle/admission.js';
import { acquireHostClaim } from '../../security/claims.js';
import type { RuntimeConnections } from '../transport/connections.js';
import type { RuntimeReconciler } from '../controller/reconcile.js';
import { runtimeDirectory, readRuntimeJson } from '../ownership/storage.js';
import { startRuntimeService } from './supervisor.js';
import { resolveInstalledRuntimeRelease } from './release.js';
import { pinRuntimeShellHooks } from '../execution/shell-hooks.js';
import type { ShellHooks } from '../../pty/shell-hooks.js';
import type { ProgrammeOperation } from '../../puddlang/runtime-turn-store.js';
import { selectRuntimeSupervisor } from './lifetime.js';
import { reserveRuntimeLaunchMemory } from '../resources/host/bootstrap.js';

interface LaunchOptions {
  provider?: RuntimeProviderLaunch;
  codeRunDirectory?: string;
  programme?: ProgrammeOperation;
  beforeLaunch?: (release: RuntimeSelectedRelease) => void;
}

export type RuntimeSelectedRelease = ReturnType<typeof resolveInstalledRuntimeRelease>;
export type RuntimeLaunchGuard = NonNullable<LaunchOptions['beforeLaunch']>;

/** Production uses the installed selector and discovers the host's service manager. */
export type RuntimeLaunchConfiguration = {
  /** Explicit supervisor override for isolated fixtures. */
  kind?: RuntimeSupervisor['kind'];
  /** Supervisor command runner; isolated integration tests supply a fake supervisor. */
  run?: CompilationCommandRunner;
} & (
  | {
      /** Read the independent runtime selector for every new launch. */
      installed: true;
    }
  | {
      nodePath: string;
      entryPath: string;
      releasePath: string;
      build: string;
    }
);

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
  private readonly admission = new HostAdmission();
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly deps: Dependencies,
    private readonly configuration: RuntimeLaunchConfiguration,
  ) {}

  selectedRelease(): RuntimeSelectedRelease {
    if ('installed' in this.configuration) return resolveInstalledRuntimeRelease(this.deps.home);
    return {
      nodePath: realpathSync(this.configuration.nodePath),
      entryPath: realpathSync(this.configuration.entryPath),
      releasePath: realpathSync(this.configuration.releasePath),
      build: this.configuration.build,
      protocol: RUNTIME_PROTOCOL_VERSION,
    };
  }

  private async supervisor(): Promise<RuntimeSupervisor['kind']> {
    if (this.configuration.kind !== undefined) return this.configuration.kind;
    try {
      return await selectRuntimeSupervisor(this.deps.home, this.configuration.run);
    } catch {
      throw new ApiError(
        503,
        'runtime_supervisor_unavailable',
        'This host has no available runtime lifetime. Check its service manager or installation.',
      );
    }
  }

  async checkAvailable(): Promise<void> {
    this.admission.assertOpen();
    await this.lifetime();
    this.selectedRelease();
    this.admission.assertOpen();
  }

  private async lifetime() {
    const kind = await this.supervisor();
    const bootId = await readHostBootIdentity();
    if (kind === 'detached' && bootId === null)
      throw new ApiError(
        503,
        'runtime_boot_unknown',
        'The host boot cannot be verified for a detached runtime.',
      );
    return { kind, bootId };
  }

  launch(
    sessionId: string,
    command: (hooks: ShellHooks) => RuntimeCommand,
    options: LaunchOptions = {},
  ): Promise<void> {
    if (this.closed)
      return Promise.reject(new ApiError(503, 'host_maintenance', 'Runtime launcher is closing'));
    if (this.pending.size >= RUNTIME_LIMITS.pendingRequests)
      return Promise.reject(ApiError.conflict('runtime_busy', 'Too many pending runtime launches'));
    let release: () => void;
    try {
      release = this.admission.enter();
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = this.start(sessionId, command, options).finally(release);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  private async start(
    sessionId: string,
    command: (hooks: ShellHooks) => RuntimeCommand,
    { provider, codeRunDirectory, programme, beforeLaunch }: LaunchOptions,
  ): Promise<void> {
    // Establish lifetime support before recording any launch intent. An unavailable
    // manager must not leave a prepared owner or select the old in-process backend.
    const { kind, bootId } = await this.lifetime();
    if (this.closed) throw new ApiError(503, 'host_maintenance', 'Runtime launcher is closing');
    const session = this.deps.sessions.get(sessionId);
    if (this.deps.runtimes.ownerOf(sessionId))
      throw ApiError.conflict('runtime_owned', 'This placement already has an independent owner');
    const project = this.deps.projects.get(session.project_id);
    // Pin selectors before writing intent. Updating a default cannot change this launch.
    const selected = this.selectedRelease();
    const config = { ...this.configuration, ...selected, environment: this.deps.environment };
    beforeLaunch?.(selected);
    const identity = {
      runtime_id: randomUUID(),
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: project.profile_id,
      project_id: project.id,
      session_id: sessionId,
      canonical_worktree_path: realpathSync(session.worktree_path),
    };
    const claim = acquireHostClaim(this.deps.home, `runtime-launch:${identity.runtime_id}`);
    let recorded = false;
    let dispatched = false;
    try {
      const directory = runtimeDirectory(this.deps.home, identity.runtime_id);
      const launch: RuntimeLaunch = runtimeLaunchSchema.parse({
        format: 1,
        identity,
        secret: randomBytes(32).toString('hex'),
        boot_id: bootId ?? undefined,
        lifetime: kind === 'detached' ? 'host_session' : 'service',
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
      const launchBytes = Buffer.byteLength(JSON.stringify(launch));
      if (launchBytes > RUNTIME_LIMITS.frameBytes)
        throw new Error('Runtime launch context exceeds its private record limit');
      atomicPrivateJson(join(directory, 'launch.json'), launch);
      this.deps.runtimes.prepare({
        identity,
        build: config.build,
        protocol: config.protocol,
        releasePath: config.releasePath,
        programme,
        ...(codeRunDirectory === undefined
          ? {}
          : { codeRunDirectory: realpathSync(codeRunDirectory) }),
      });
      recorded = true;
      try {
        reserveRuntimeLaunchMemory(this.deps.home, identity, launchBytes);
      } catch {
        throw new ApiError(
          503,
          'runtime_memory_unavailable',
          'Host memory admission is unavailable for a new runtime. Existing runtimes continue running.',
        );
      }
      // After this point an uncertain response must preserve intent and never try
      // another backend. The same launch claim also prevents premature retirement.
      try {
        dispatched = true;
        await startRuntimeService(this.deps.home, identity, { ...config, kind });
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
      if (recorded && !dispatched) {
        try {
          await this.deps.reconciler.retire(identity.runtime_id);
        } catch {
          // Preserve exact launch evidence if retirement cannot commit. An
          // uncertain grant is never silently erased or dispatched later.
        }
      }
    }
  }

  /** Let admitted launches settle before observation is paused; never replay rejected launches. */
  pause(): ReturnType<HostAdmission['pause']> {
    return this.admission.pause();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.admission.close();
    await Promise.allSettled([...this.pending]);
  }
}
