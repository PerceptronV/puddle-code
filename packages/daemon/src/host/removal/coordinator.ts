import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  hostRemovalFinishSchema,
  hostRemovalRuntimeReviewSchema,
  hostRemovalServicesSchema,
  type HostRemovalFinish,
  type HostRemovalRuntimeReview,
} from '@puddle/shared';
import { atomicPrivateJson, digest, readPrivateJson } from '@puddle/shared/node';
import { inspectHostRemoval } from '@puddle/shared/node/host-control';
import { withRemovalRuntimes } from './controller.js';
import { HostRemovalGuard } from './guard.js';
import { reviewInstalledRemovalServices, type RemovalInventoryOptions } from './inventory.js';
import { HostRemovalServiceOperation } from './operations/services.js';
import { removalRemoteAccess } from './remote.js';
import type { RuntimeRemovalReview } from './runtimes.js';

interface Options extends RemovalInventoryOptions {
  authorised: () => boolean;
}

/** A receipt binds the exact runtime disposition, not just completed service unregistration. */
export function inspectHostRemovalResult(home: string): HostRemovalFinish | null {
  inspectHostRemoval(home);
  try {
    return hostRemovalFinishSchema.parse(
      readPrivateJson(join(home, 'installation/removal/result.json'), 4096),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function publicReview(id: string, review: RuntimeRemovalReview): HostRemovalRuntimeReview {
  return hostRemovalRuntimeReviewSchema.parse({
    id,
    fingerprint: digest(JSON.stringify({ id, review })),
    owners: review.owners.map((owner) => ({
      id: owner.id,
      session: owner.session,
      version: owner.version,
      terminals: owner.terminals?.length ?? null,
      stop_blocker: 'reason' in owner.stop ? owner.stop.reason : null,
    })),
  });
}

function requireSelected(guard: HostRemovalGuard, release: string, options: Options): void {
  guard.requireHeld();
  if (!options.authorised()) throw new Error('Host removal authority expired');
  if (realpathSync(join(guard.home, 'bin/current')) !== release)
    throw new Error('Selected release changed during removal');
}

async function stopServices(
  guard: HostRemovalGuard,
  operation: HostRemovalServiceOperation,
  options: Options,
) {
  const remote = (action: 'disable' | 'verify' | 'continue') =>
    removalRemoteAccess(
      guard,
      action === 'continue' ? { removalId: operation.read().id } : action,
      options.authorised,
      options.run,
    );
  await operation.disableRemote(
    () => remote('disable'),
    () => remote('verify'),
    () => remote('continue'),
  );
  for (const { review } of operation.read().services) {
    const steps = operation.read().actions;
    // Once unregistration was attempted, definition absence is expected. Its
    // fresh proof happens under the offline controller, not a replayed stop.
    if (operation.unregistrationState(review.component) !== 'planned') continue;
    await remote('verify');
    const stop = steps.find(({ action }) => action === `stop-${review.component}`)!;
    if (stop.state === 'planned') await operation.stop(review.component);
    else await operation.observe(review.component, 'stop');
  }
}

/** Explicit removal consent precedes this call. Stop services before reviewing runtime impact. */
export async function prepareHostRemoval(
  home: string,
  release: string,
  resume: string | undefined,
  options: Options,
): Promise<HostRemovalRuntimeReview> {
  if (resume) hostRemovalServicesSchema.shape.id.parse(resume);
  const guard = HostRemovalGuard.acquire(home);
  try {
    requireSelected(guard, release, options);
    const state = inspectHostRemoval(home);
    if (state.state === 'restoring')
      throw new Error('Resolve service restoration before removing this host');
    let operation: HostRemovalServiceOperation;
    if (resume) {
      operation = HostRemovalServiceOperation.open(guard, options);
      if (operation.read().id !== resume) throw new Error('Removal identity changed');
    } else {
      if (state.state !== 'none' && state.state !== 'restored')
        throw new Error('Continue the exact recorded removal');
      const reviews = await reviewInstalledRemovalServices(guard, options);
      requireSelected(guard, release, options);
      operation = await HostRemovalServiceOperation.prepare(guard, reviews, {
        ...options,
        disableRemote: true,
      });
    }
    await stopServices(guard, operation, options);
    return await withRemovalRuntimes(
      home,
      async (runtimes) => {
        requireSelected(guard, release, options);
        return publicReview(operation.read().id, await runtimes.review(options.authorised));
      },
      guard,
    );
  } finally {
    guard.release();
  }
}

/** Exact, freshly reviewed disposition. No release files, runtime records or user data are deleted. */
export async function finishHostRemoval(
  home: string,
  release: string,
  input: HostRemovalFinish,
  options: Options,
): Promise<void> {
  const request = hostRemovalFinishSchema.parse(input);
  const guard = HostRemovalGuard.acquire(home);
  try {
    requireSelected(guard, release, options);
    if (inspectHostRemoval(home).state === 'restoring')
      throw new Error('Resolve service restoration before removing this host');
    const operation = HostRemovalServiceOperation.open(guard, options);
    if (operation.read().id !== request.id) throw new Error('Removal identity changed');
    // Finish never dispatches a stop that was not already requested by prepare.
    if (
      operation
        .read()
        .actions.some(
          ({ action, state }) => !action.startsWith('unregister-') && state !== 'finished',
        )
    )
      throw new Error('Complete service shutdown before runtime disposition');
    await stopServices(guard, operation, options);
    await withRemovalRuntimes(
      home,
      async (runtimes) => {
        const review = await runtimes.review(options.authorised);
        if (publicReview(request.id, review).fingerprint !== request.fingerprint)
          throw new Error('Runtime removal impact changed; review it again');
        await runtimes.apply(review, request.disposition, options.authorised);
        for (const { review: service } of operation.read().services) {
          requireSelected(guard, release, options);
          await removalRemoteAccess(guard, 'verify', options.authorised, options.run);
          if (operation.unregistrationState(service.component) === 'planned')
            await operation.unregister(service.component);
          else await operation.continueUnregistration(service.component);
        }
        await removalRemoteAccess(guard, 'verify', options.authorised, options.run);
        requireSelected(guard, release, options);
      },
      guard,
    );
    requireSelected(guard, release, options);
    atomicPrivateJson(join(home, 'installation/removal/result.json'), request, {
      syncDirectory: true,
    });
  } finally {
    guard.release();
  }
}
