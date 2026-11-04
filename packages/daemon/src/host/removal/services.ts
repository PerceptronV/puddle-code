import { lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest } from '@puddle/shared/node';
import type { HostRemovalServiceReview } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { supervisorCommand } from '../services.js';
import {
  readOwnedServiceDefinition,
  serviceDefinitionDigest,
  requireSelectedDaemonExecutable,
} from '../supervision/definition.js';
import { inspectRunningService } from '../supervision/inspection.js';
import {
  serviceHasNoProcess,
  serviceIsStopped,
  unloadIdleLaunchdService,
} from '../supervision/stopped.js';
import { serviceIsRemoved } from '../supervision/removed.js';
import { stopServiceForReplacement } from '../supervision/replacement.js';
import { validServiceTarget, type ServiceTarget } from '../supervision/target.js';
import { HostRemovalGuard } from './guard.js';

/** Private reviewed evidence; never accept executable paths or definitions from a browser. */
export type RemovalServiceReview = HostRemovalServiceReview;

function requireTarget(target: ServiceTarget): void {
  validServiceTarget(target);
  if (target.kind === 'launchd' && target.domain !== `gui/${process.getuid?.()}`)
    throw new Error('Host removal service belongs to another user');
}

function requireAuthority(guard: HostRemovalGuard, authorised: () => boolean): void {
  guard.requireHeld();
  if (!authorised()) throw new Error('Host removal authority expired');
}

/** Inspect the exact user-owned source and loaded definition before offering interruption. */
export async function reviewRemovalService(
  guard: HostRemovalGuard,
  target: ServiceTarget,
  component: RemovalServiceReview['component'],
  expectedPid: number | null,
  options: { userHome?: string; run?: CompilationCommandRunner } = {},
): Promise<RemovalServiceReview> {
  guard.requireHeld();
  requireTarget(target);
  const run = guard.commands(options.run);
  const definition =
    target.kind === 'systemd'
      ? join(options.userHome ?? homedir(), '.config/systemd/user', target.name)
      : join(options.userHome ?? homedir(), 'Library/LaunchAgents', `${target.name}.plist`);
  const sourceDigest = digest(await readOwnedServiceDefinition(definition));
  if (lstatSync(definition).nlink !== 1)
    throw new Error('Linked host service definition cannot be removed');
  if (target.kind === 'systemd') {
    const source = await supervisorCommand(guard.home, run)('systemctl', [
      '--user',
      'show',
      '--property=FragmentPath',
      '--value',
      target.name,
    ]);
    if (source.stdout.trim() !== definition)
      throw new Error('Loaded host service uses another definition');
    if (component === 'daemon') await requireSelectedDaemonExecutable(guard.home, target, run);
  }
  const definitionDigest = await serviceDefinitionDigest(
    guard.home,
    target,
    target.kind === 'launchd' ? definition : null,
    run,
    component,
  );
  const observed =
    expectedPid === null ? null : await inspectRunningService(guard.home, target, expectedPid, run);
  if (!observed && !(await serviceHasNoProcess(guard.home, target, run)))
    throw new Error('Host removal service is not positively stopped');
  const review = {
    target,
    component,
    definition,
    sourceDigest,
    definitionDigest,
    process: observed,
  };
  await requireUnchanged(guard, review, run);
  return review;
}

async function requireUnchanged(
  guard: HostRemovalGuard,
  review: RemovalServiceReview,
  run: CompilationCommandRunner,
): Promise<void> {
  guard.requireHeld();
  requireTarget(review.target);
  if (
    digest(await readOwnedServiceDefinition(review.definition)) !== review.sourceDigest ||
    lstatSync(review.definition).nlink !== 1
  )
    throw new Error('Host service source changed during removal');
  if (
    (await serviceDefinitionDigest(
      guard.home,
      review.target,
      review.target.kind === 'launchd' ? review.definition : null,
      run,
      review.component,
    )) !== review.definitionDigest
  )
    throw new Error('Host service configuration changed during removal');
}

function processEnded(review: RemovalServiceReview): boolean {
  if (!review.process) return true;
  try {
    process.kill(review.process.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
  // Never signal a recorded PID or infer that an unrelated reused PID is ours.
  return false;
}

/** Observe a consumed stop after interruption; never issue another supervisor command. */
export async function verifyRemovalServiceStopped(
  guard: HostRemovalGuard,
  review: RemovalServiceReview,
  authorised: () => boolean,
  runCommand?: CompilationCommandRunner,
): Promise<void> {
  const run = guard.commands(runCommand);
  requireAuthority(guard, authorised);
  await requireUnchanged(guard, review, run);
  if (!(await serviceIsStopped(guard.home, review.target, run, true)) || !processEnded(review))
    throw new Error('Host service shutdown is unconfirmed');
  requireAuthority(guard, authorised);
}

/** A missing source alone never proves that the service was unregistered. */
export async function verifyRemovalServiceUnregistered(
  guard: HostRemovalGuard,
  review: RemovalServiceReview,
  authorised: () => boolean,
  runCommand?: CompilationCommandRunner,
): Promise<void> {
  guard.requireController();
  requireAuthority(guard, authorised);
  requireTarget(review.target);
  const requireAbsent = () => {
    try {
      lstatSync(review.definition);
      throw new Error('Host service definition remains after unregistration');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  requireAbsent();
  if (
    !(await serviceIsRemoved(guard.home, review.target, guard.commands(runCommand))) ||
    !processEnded(review)
  )
    throw new Error('Host service unregistration is unconfirmed');
  guard.requireController();
  requireAuthority(guard, authorised);
  requireAbsent();
}

/** One reviewed stop, then observation only; definition files remain available after cancellation. */
export async function stopRemovalService(
  guard: HostRemovalGuard,
  review: RemovalServiceReview,
  authorised: () => boolean,
  beforeStop: () => void,
  runCommand?: CompilationCommandRunner,
): Promise<void> {
  const run = guard.commands(runCommand);
  const current = async () => {
    requireAuthority(guard, authorised);
    await requireUnchanged(guard, review, run);
    requireAuthority(guard, authorised);
  };
  await current();
  if (!review.process) {
    if (!(await serviceHasNoProcess(guard.home, review.target, run)))
      throw new Error('Host service started after removal review');
    await unloadIdleLaunchdService(guard.home, review.target, current, run, () => {
      requireAuthority(guard, authorised);
      beforeStop();
    });
  } else {
    let dispatched = false;
    try {
      await stopServiceForReplacement(
        guard.home,
        {
          ...review.process,
          definition_path: review.target.kind === 'launchd' ? review.definition : null,
          definition_digest: review.definitionDigest,
          component: review.component,
        },
        () => {
          requireAuthority(guard, authorised);
          beforeStop();
          dispatched = true;
        },
        run,
      );
    } catch (error) {
      if (!dispatched) throw error;
      // A lost stop acknowledgement is followed by inspection, never another stop.
    }
  }
  const deadline = Date.now() + 15_000;
  for (;;) {
    await current();
    if ((await serviceIsStopped(guard.home, review.target, run, true)) && processEnded(review))
      return;
    if (Date.now() >= deadline) throw new Error('Host service shutdown is unconfirmed');
    await delay(100);
  }
}

/** Caller retains controller ownership as well as this guard until file handling finishes. */
export async function unregisterRemovalService(
  guard: HostRemovalGuard,
  review: RemovalServiceReview,
  authorised: () => boolean,
  beforeUnregister: () => void,
  runCommand?: CompilationCommandRunner,
): Promise<void> {
  guard.requireController();
  const run = guard.commands(runCommand);
  const current = async () => {
    guard.requireController();
    await verifyRemovalServiceStopped(guard, review, authorised, runCommand);
    guard.requireController();
  };
  await current();
  beforeUnregister();
  requireAuthority(guard, authorised);
  const execute = supervisorCommand(guard.home, run);
  if (review.target.kind === 'systemd') {
    await execute('systemctl', ['--user', 'disable', review.target.name]);
    await current();
    if (!(await serviceIsStopped(guard.home, review.target, run))) {
      await execute('systemctl', ['--user', 'reset-failed', review.target.name]);
      await current();
      if (!(await serviceIsStopped(guard.home, review.target, run)))
        throw new Error('Failed host service was not reset');
    }
  }
  await current();
  const source = await readOwnedServiceDefinition(review.definition);
  if (digest(source) !== review.sourceDigest || lstatSync(review.definition).nlink !== 1)
    throw new Error('Host service source changed before deletion');
  // There is no asynchronous boundary between this final check and unlink.
  requireAuthority(guard, authorised);
  unlinkSync(review.definition);
  if (review.target.kind === 'systemd') await execute('systemctl', ['--user', 'daemon-reload']);
  await verifyRemovalServiceUnregistered(guard, review, authorised, runCommand);
}
