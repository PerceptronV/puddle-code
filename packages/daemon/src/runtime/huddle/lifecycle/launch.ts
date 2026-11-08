import { copyHuddleRecoverySeed } from '../recovery/seed.js';
import { requireHuddleHostFeatures } from '../triggers/definitions.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  RUNTIME_LIMITS,
  huddleOwnerLaunchSchema,
  type HuddleRevisionActivation,
  type HuddleOwnerLaunch,
  type HuddleContainment,
  type RuntimeSupervisor,
} from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import {
  runCompilationCommand,
  type CompilationCommandRunner,
} from '../../../compilation/process.js';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import type { HuddleDefinitionSnapshot } from '../../../huddle/definitions/capture.js';
import { ApiError } from '../../../http/errors.js';
import { acquireHostClaim } from '../../../security/claims.js';
import type { RuntimeConnections } from '../../transport/connections.js';
import type { RuntimeReconciler } from '../../controller/reconcile.js';
import { runtimeDirectory } from '../../ownership/storage.js';
import { startRuntimeService } from '../../lifecycle/supervisor.js';
import { reserveRuntimeLaunchMemory } from '../../resources/host/bootstrap.js';
import { HuddleRevisionStore } from '../state/revisions.js';
import { prepareHuddleActivation } from '../control/revisions.js';
import { requireHuddleRuntimeSelection, type HuddleRuntimeRelease } from '../control/release.js';

export interface HuddleLaunchOptions {
  snapshot: HuddleDefinitionSnapshot;
  recoverySource?: HuddleOwnerLaunch;
  recoveryContainment?: HuddleContainment;
  automaticCrashRecovery?: boolean;
  hostId: string;
  variables: HuddleRevisionActivation['variables'];
  bindings: HuddleRevisionActivation['bindings'];
  authorised(): boolean;
  beforeLaunch?: (release: HuddleRuntimeRelease) => void;
}
interface Dependencies {
  home: string;
  environment: Record<string, string>;
  sessions: SessionStore;
  projects: ProjectStore;
  runtimes: RuntimeStore;
  connections: RuntimeConnections;
  reconciler: RuntimeReconciler;
}

/** Shared launcher admission owns this entire attempt; no alternate backend or redispatch exists. */
export async function launchHuddleOwner(
  deps: Dependencies,
  sessionId: string,
  selected: HuddleRuntimeRelease,
  lifetime: { kind: RuntimeSupervisor['kind']; bootId: string | null },
  options: HuddleLaunchOptions,
  closed: () => boolean,
  run?: CompilationCommandRunner,
): Promise<void> {
  const requireAuthority = () => {
    if (closed() || !options.authorised())
      throw new ApiError(401, 'upstream_expired', 'Connection authority expired');
  };
  requireAuthority();
  if (
    Object.values(options.snapshot.components).some(
      (component) =>
        component.category !== 'trigger' && component.capabilities.includes('sessions'),
    ) &&
    selected.huddle.operations !== 2
  )
    throw ApiError.conflict(
      'huddle_execution_unsupported',
      'Selected runtime does not support huddle agent dispatch',
    );
  try {
    requireHuddleHostFeatures(options.snapshot, selected.huddle);
  } catch (error) {
    throw ApiError.conflict(
      'huddle_execution_unsupported',
      error instanceof Error ? error.message : String(error),
    );
  }
  const session = deps.sessions.get(sessionId);
  if (session.kind !== 'huddle' || session.huddle_id !== options.snapshot.definition.id)
    throw ApiError.conflict(
      'huddle_identity_changed',
      'Huddle definition does not match its placement',
    );
  if (session.status === 'archived')
    throw ApiError.conflict('huddle_archived', 'Unarchive this huddle before starting it');
  if (!options.recoverySource && deps.runtimes.hasUnreleasedHuddle(sessionId))
    throw ApiError.conflict(
      'huddle_owned',
      'This huddle has an existing or unresolved owner; inspect it before starting another',
    );
  const project = deps.projects.get(session.project_id);
  options.beforeLaunch?.(selected);
  requireAuthority();
  requireHuddleRuntimeSelection(deps.home, selected);
  const identity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: project.profile_id,
    project_id: project.id,
    session_id: session.id,
    canonical_worktree_path: realpathSync(session.worktree_path),
  };
  const claim = acquireHostClaim(deps.home, `runtime-launch:${identity.runtime_id}`);
  let recorded = false;
  let dispatched = false;
  try {
    const directory = runtimeDirectory(deps.home, identity.runtime_id);
    const revisions = new HuddleRevisionStore(deps.home, identity.runtime_id, session.huddle_id!);
    const prepared = options.recoverySource
      ? copyHuddleRecoverySeed(
          deps.home,
          options.recoverySource,
          identity,
          lifetime.bootId!,
          selected.huddle,
          options.recoveryContainment,
          options.automaticCrashRecovery,
        )
      : prepareHuddleActivation(
          options.snapshot,
          {
            id: randomUUID(),
            worktree: identity.canonical_worktree_path,
            variables: options.variables,
            bindings: options.bindings,
          },
          session.huddle_id!,
        );
    revisions.publish(prepared.snapshot);
    const launch = huddleOwnerLaunchSchema.parse({
      format: 1,
      ...('recovery' in prepared ? { recovery: prepared.recovery } : {}),
      role: 'huddle',
      contract: selected.huddle.owner,
      capabilities: selected.huddle,
      identity,
      secret: randomBytes(32).toString('hex'),
      build: selected.build,
      scope: {
        hostId: options.hostId,
        runtimeId: identity.runtime_id,
        profileId: project.profile_id,
        projectId: project.id,
        sessionId: session.id,
        huddleId: session.huddle_id,
      },
      boot_id: lifetime.bootId ?? undefined,
      lifetime: lifetime.kind === 'detached' ? 'host_session' : 'service',
      initial: {
        id: prepared.activation.id,
        revision: prepared.activation.revision,
        worktree: prepared.activation.worktree,
        variables: prepared.activation.variables,
        bindings: prepared.activation.bindings,
      },
    });
    const bytes = Buffer.byteLength(JSON.stringify(launch));
    if (bytes > RUNTIME_LIMITS.frameBytes)
      throw new Error('Huddle launch context exceeds its private record limit');
    // Publication is reversible preparation. Recheck authority and selection before durable ownership.
    requireAuthority();
    if (deps.sessions.get(sessionId).status === 'archived')
      throw ApiError.conflict('huddle_archived', 'The huddle was archived before launch admission');
    requireHuddleRuntimeSelection(deps.home, selected);
    atomicPrivateJson(join(directory, 'launch.json'), launch, { syncDirectory: true });
    deps.runtimes.prepare({
      identity,
      build: selected.build,
      protocol: selected.protocol,
      releasePath: selected.releasePath,
      huddle: {
        id: session.huddle_id!,
        capabilities: selected.huddle,
        ...(options.recoverySource ? { recoveryFrom: options.recoverySource.identity } : {}),
      },
    });
    recorded = true;
    try {
      reserveRuntimeLaunchMemory(deps.home, identity, bytes);
    } catch {
      throw new ApiError(
        503,
        'runtime_memory_unavailable',
        'Host memory admission is unavailable for a new huddle',
      );
    }
    requireAuthority();
    requireHuddleRuntimeSelection(deps.home, selected);
    dispatched = true;
    try {
      await startRuntimeService(deps.home, identity, {
        ...selected,
        kind: lifetime.kind,
        environment: deps.environment,
        run: async (command) => {
          requireAuthority();
          requireHuddleRuntimeSelection(deps.home, selected);
          return (run ?? runCompilationCommand)(command);
        },
      });
    } catch {
      /* The supervisor may have accepted before its reply was lost. Observe only. */
    }
    const deadline = Date.now() + 15_000;
    let delay = 50;
    while (!closed()) {
      requireAuthority();
      await deps.connections.connectOwner(identity.runtime_id);
      const binding = deps.runtimes.get(identity.runtime_id);
      const client = deps.connections.getHuddle(identity.runtime_id);
      if (
        binding?.state === 'running' &&
        client?.state &&
        deps.reconciler.settled(identity.runtime_id)
      )
        return;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 1000);
    }
    throw ApiError.conflict(
      'runtime_launch_unconfirmed',
      'The huddle launch is recorded but readiness is unconfirmed. Inspect it before another launch; no command was replayed.',
    );
  } finally {
    try {
      if (!recorded && !dispatched && !deps.runtimes.get(identity.runtime_id))
        rmSync(join(deps.home, 'runtimes', identity.runtime_id), { recursive: true, force: true });
    } finally {
      claim.release();
    }
    if (recorded && !dispatched) {
      try {
        await deps.reconciler.retire(identity.runtime_id);
      } catch {
        /* Retain uncertain intent and any memory grant for explicit recovery. */
      }
    }
  }
}
