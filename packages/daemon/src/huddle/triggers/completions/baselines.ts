import { realpathSync } from 'node:fs';
import {
  canonicalHuddleJson,
  huddleCompletionPlanSchema,
  type HuddleCompletionBaseline,
} from '@puddle/shared';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { RuntimeConnections } from '../../../runtime/transport/connections.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import type { HuddleCompletionBaselineCapture } from '../../../runtime/huddle/controller/controls.js';
import {
  huddleControlTarget,
  requireHuddleControl,
} from '../../../runtime/huddle/controller/observations.js';
import { requireHuddleDefinitionLocation } from '../../definitions/location.js';
import { HuddleCompletionReader, type CompletionReaderDependencies } from './reader.js';
import { ApiError } from '../../../http/errors.js';
import { RuntimeConnectionLost } from '../../../runtime/transport/client.js';
import { HuddleOwnerRejected } from '../../../runtime/huddle/transport/client.js';

function unavailable(error: unknown): never {
  if (
    error instanceof ApiError ||
    error instanceof RuntimeConnectionLost ||
    error instanceof HuddleOwnerRejected
  )
    throw error;
  throw ApiError.conflict(
    'huddle_completion_unavailable',
    'Completion source or owner changed or is unavailable; inspect the selected agents before arming',
  );
}

/** Captures only after queued review; returns a final synchronous dispatch check. */
export class HuddleCompletionBaselines {
  private readonly reader: HuddleCompletionReader;
  constructor(
    private readonly deps: CompletionReaderDependencies & {
      runtimes: Pick<RuntimeStore, 'ownerOf' | 'stopRequested'>;
      connections: Pick<RuntimeConnections, 'get' | 'getHuddle'>;
    },
  ) {
    this.reader = new HuddleCompletionReader(deps);
  }

  readonly capture: HuddleCompletionBaselineCapture = async (...args) => {
    try {
      const captured = await this.prepare(...args);
      return {
        baselines: captured.baselines,
        check: () => {
          try {
            captured.check();
          } catch (error) {
            unavailable(error);
          }
        },
      };
    } catch (error) {
      unavailable(error);
    }
  };

  private readonly prepare: HuddleCompletionBaselineCapture = async (
    client,
    state,
    activation,
    guard,
  ) => {
    const expected = huddleControlTarget(state);
    const checkOwner = () => {
      guard();
      const scope = state.scope,
        binding = this.deps.runtimes.ownerOf(scope.sessionId);
      const project = this.deps.projects.get(scope.projectId),
        session = this.deps.sessions.get(scope.sessionId);
      if (
        !binding ||
        binding.role !== 'huddle' ||
        binding.state !== 'running' ||
        binding.huddle_id !== scope.huddleId ||
        canonicalHuddleJson(runtimeBindingIdentity(binding)) !==
          canonicalHuddleJson(state.identity) ||
        this.deps.runtimes.stopRequested(binding.runtime_id) ||
        this.deps.connections.getHuddle(binding.runtime_id) !== client ||
        project.profile_id !== scope.profileId ||
        project.archived ||
        session.project_id !== scope.projectId ||
        session.kind !== 'huddle' ||
        session.huddle_id !== scope.huddleId ||
        session.status === 'archived' ||
        realpathSync(session.worktree_path) !== state.identity.canonical_worktree_path ||
        !client.state ||
        canonicalHuddleJson(client.state.identity) !== canonicalHuddleJson(state.identity) ||
        canonicalHuddleJson(client.state.scope) !== canonicalHuddleJson(state.scope) ||
        client.state.state !== 'running' ||
        client.state.failure ||
        client.state.persistencePending ||
        client.state.capabilities.completionEvents !== 1 ||
        client.state.capabilities.completionPlans !== 1
      )
        throw new Error('Completion baseline owner authority changed');
      requireHuddleControl(client.state, expected);
      requireHuddleDefinitionLocation(state.identity.canonical_worktree_path, scope.huddleId);
    };
    checkOwner();
    const response = await client.request({
      t: 'completion-plan',
      ...(activation ? { activation } : {}),
    });
    checkOwner();
    if (response.t !== 'completion-plan') throw new Error('Completion plan unavailable');
    const plan = huddleCompletionPlanSchema.parse(response.plan);
    if (
      plan.generation !== expected.generation ||
      plan.activationId !== (activation?.id ?? expected.activationId) ||
      (activation && plan.revision !== activation.revision)
    )
      throw new Error('Completion plan changed during review');
    const baselines: HuddleCompletionBaseline[] = [],
      checks: Array<() => void> = [];
    for (const source of plan.sources) {
      const captured = await this.reader.capture(state.scope, source, checkOwner);
      checkOwner();
      baselines.push(captured.baseline);
      checks.push(captured.check);
    }
    const check = () => {
      checkOwner();
      for (const verify of checks) verify();
    };
    check();
    return { baselines, check };
  };
}
