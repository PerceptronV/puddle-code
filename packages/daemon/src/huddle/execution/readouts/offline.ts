import { huddleSecretResolver } from '../../integrations/secrets.js';
import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HuddleOwnerLaunch } from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import type { RuntimeBinding } from '../../../db/stores/runtimes.js';
import { ApiError } from '../../../http/errors.js';
import { HostAdmission } from '../../../host/lifecycle/admission.js';
import { acquireHostClaim } from '../../../security/claims.js';
import { acquireRuntimeRetirementClaims } from '../../../runtime/ownership/retirement-claims.js';
import { readRuntimeJson } from '../../../runtime/ownership/storage.js';
import { huddleRetirementState } from '../../../runtime/huddle/ownership/retirement.js';
import { HuddleLedger } from '../../../runtime/huddle/state/ledger.js';
import { HuddleRevisionStore } from '../../../runtime/huddle/state/revisions.js';
import { retainedHuddleDirectory } from '../../../runtime/huddle/state/readers/database.js';
import { HuddleRevisionController } from '../../../runtime/huddle/control/revisions.js';
import { prepareReadoutObservation } from '../../../runtime/huddle/readouts/observation.js';
import {
  startHuddleWorker,
  type HuddleWorkerHandle,
} from '../../../runtime/huddle/workers/process.js';
import { RuntimeBufferBudget } from '../../../runtime/resources/budget.js';

/** One bounded observation worker. No scheduler, subscription, agent dispatch or graph restart. */
export class HuddleOfflineReadouts {
  private readonly admission = new HostAdmission();
  private readonly budget = new RuntimeBufferBudget({ bytes: 192 * 1024 * 1024, count: 256 });
  private active: { handle: HuddleWorkerHandle; ended: Promise<void> } | null = null;

  constructor(
    private readonly home: string,
    private readonly workerEntry = fileURLToPath(
      // Release bundles put helpers beside puddled; tsc keeps the source hierarchy.
      existsSync(new URL('./huddle/runner.js', import.meta.url))
        ? new URL('./huddle/runner.js', import.meta.url)
        : new URL('../../../runtime/huddle/workers/runner.js', import.meta.url),
    ),
  ) {}

  observe(
    binding: RuntimeBinding,
    launch: HuddleOwnerLaunch,
    operationId: string,
    check: () => void,
  ) {
    const leave = this.admission.enter();
    let releaseWorker: (() => void) | null = null;
    const claims: Array<{ release(): void }> = [];
    let ledger: HuddleLedger | undefined;
    const release = () => {
      try {
        ledger?.close();
      } finally {
        for (const claim of claims.reverse()) claim.release();
        releaseWorker?.();
        leave();
      }
    };
    try {
      if (this.active)
        throw ApiError.conflict(
          'huddle_readout_busy',
          'Another retained readout observation is running',
        );
      check();
      const directory = retainedHuddleDirectory(this.home, binding.runtime_id);
      claims.push(acquireRuntimeRetirementClaims(this.home, binding.runtime_id));
      claims.push(acquireHostClaim(this.home, `huddle-revisions:${binding.runtime_id}`));
      // A disconnected controller or stale PID is insufficient. Clean owner shutdown
      // records that script workers drained, and consumed.json fences a delayed launch.
      const { clean, state, consumed } = huddleRetirementState(
        binding,
        launch,
        readRuntimeJson(join(directory, 'huddle-owner.json')),
        readRuntimeJson(join(directory, 'consumed.json')),
      );
      if (binding.state !== 'exited' || !clean || !state || !consumed)
        throw ApiError.conflict(
          'huddle_readout_recovery_required',
          'Retained readout observation requires a confirmed cleanly stopped owner; recover an interrupted owner first',
        );
      if (launch.capabilities.readoutObservation !== 1)
        throw ApiError.conflict(
          'huddle_execution_unsupported',
          'The recorded runtime does not support readout observation',
        );
      releaseWorker = this.budget.reserve(160 * 1024 * 1024);
      if (!releaseWorker)
        throw ApiError.conflict('huddle_readout_busy', 'Readout worker memory is unavailable');
      // This action may update an existing ledger, never recreate missing retained state.
      const file = join(directory, 'huddle.sqlite');
      privatePath(file);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size < 100 || stat.size > 128 * 1024 * 1024)
        throw new Error('Retained readout ledger is unavailable');
      privatePath(join(directory, 'huddle-revisions'), true);
      ledger = new HuddleLedger(
        this.home,
        launch.scope,
        undefined,
        launch.recovery ? [launch.recovery.source, ...launch.recovery.ancestors] : [],
      );
      const revisions = new HuddleRevisionController(
        ledger,
        new HuddleRevisionStore(this.home, binding.runtime_id, launch.scope.huddleId),
      );
      const observation = prepareReadoutObservation(ledger, revisions, operationId);
      const entryPath = realpathSync(this.workerEntry);
      check();
      ledger.operations.unknown(
        operationId,
        'Retained observation requested; delivery remains unknown until a receipt is retained',
      );
      const handle = startHuddleWorker(observation.job, {
        nodePath: process.execPath,
        secrets:
          launch.capabilities.integrationSecrets === 1
            ? huddleSecretResolver(this.home, {
                ...launch.scope,
                worktree: launch.identity.canonical_worktree_path,
              })
            : undefined,
        entryPath,
        cwd: observation.worktree,
        timeoutMs: 30_000,
        allowance: { reserve: (bytes) => this.budget.reserve(bytes) },
        request: observation.request,
      });
      const result = handle.result.catch((error: unknown) => {
        observation.failed(error instanceof Error ? error : new Error(String(error)));
      });
      // Keep claims and memory until positive exit, even after an uncertain result.
      const ended = Promise.allSettled([result, handle.exited]).then(() => {
        this.active = null;
        release();
      });
      this.active = { handle, ended };
      return { accepted: true as const, operation_id: operationId };
    } catch (error) {
      release();
      throw error;
    }
  }

  pause() {
    return this.admission.pause();
  }
  async close() {
    this.admission.close();
    this.active?.handle.cancel('Daemon stopped during retained readout observation');
    await this.active?.ended;
  }
}
