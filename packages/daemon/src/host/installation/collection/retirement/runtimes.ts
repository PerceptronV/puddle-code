import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  RUNTIME_LIMITS,
  runtimeAssetsSchema,
  runtimeLaunchSchema,
  runtimeRetiredSchema,
  runtimeSupervisorSchema,
} from '@puddle/shared';
import { atomicPrivateJson, digest, privatePath, syncPrivateDirectory } from '@puddle/shared/node';
import type { RuntimeBinding, RuntimeStore } from '../../../../db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../../../../runtime/transport/connections.js';
import { runtimeServiceName } from '../../../../runtime/lifecycle/supervisor.js';
import type { CompilationCommandRunner } from '../../../../compilation/process.js';
import { serviceIsRemoved } from '../../../supervision/removed.js';
import { optionalRecord } from '../inventory.js';
import type { CollectionBudget } from '../budget.js';
import { acquireRuntimeRetirementClaims } from '../../../../runtime/ownership/retirement-claims.js';
import { requireHuddleBindingLaunch } from '../../../../runtime/huddle/ownership/binding.js';
import { huddleRetirementState } from '../../../../runtime/huddle/ownership/retirement.js';
import { retireRuntimeMemoryGrant } from '../../../../runtime/resources/host/retirement.js';

const receiptSchema = z
  .object({
    format: z.literal(1),
    home: z.string(),
    runtime: z.uuid(),
    evidence: z.string().regex(/^[a-f0-9]{64}$/),
    fence_boot: z.uuid(),
    ended_boot: z.uuid().nullable(),
  })
  .strict()
  .refine((record) => record.ended_boot === null || record.ended_boot !== record.fence_boot);
const receiptFile = (home: string, id: string) =>
  join(home, 'runtimes', id, 'release-retirement.json');

function evidence(home: string, binding: RuntimeBinding, budget?: CollectionBudget) {
  if (
    binding.state === 'prepared' ||
    binding.state === 'running' ||
    (binding.role === 'huddle' && binding.state !== 'exited')
  )
    return null;
  const directory = join(home, 'runtimes', binding.runtime_id);
  privatePath(directory, true);
  const read = (name: string, bytes = 64 * 1024) =>
    optionalRecord(join(directory, name), bytes, budget);
  const launch = read('launch.json', RUNTIME_LIMITS.frameBytes);
  const retired = read('retired.json');
  if (!launch || !retired) return null;
  const huddle =
    binding.role === 'huddle'
      ? huddleRetirementState(
          binding,
          requireHuddleBindingLaunch(binding, launch),
          read('huddle-owner.json', RUNTIME_LIMITS.frameBytes),
          read('consumed.json'),
        )
      : null;
  if (huddle && !huddle.clean) return null;
  const identity = runtimeBindingIdentity(binding);
  for (const actual of [
    (binding.role === 'huddle'
      ? requireHuddleBindingLaunch(binding, launch)
      : runtimeLaunchSchema.parse(launch)
    ).identity,
    runtimeRetiredSchema.parse(retired).identity,
  ])
    if (JSON.stringify(actual) !== JSON.stringify(identity))
      throw new Error('Runtime retirement identity changed');
  const assets = read('assets.json');
  if (assets) runtimeAssetsSchema.parse(assets);
  const supervisor = read('supervisor.json');
  const service = supervisor ? runtimeSupervisorSchema.parse(supervisor) : null;
  if (
    service &&
    (service.state !== 'removed' || JSON.stringify(service.identity) !== JSON.stringify(identity))
  )
    return null;
  if (
    service &&
    (service.name !== runtimeServiceName(home, identity, service.kind) ||
      service.domain !== (service.kind === 'launchd' ? `gui/${process.getuid?.()}` : null))
  )
    throw new Error('Runtime retirement service target changed');
  budget?.value(Buffer.byteLength(JSON.stringify(binding)));
  return {
    directory,
    service,
    digest: digest(
      JSON.stringify({
        binding,
        launch,
        retired,
        assets,
        supervisor,
        ...(huddle ? { huddle } : {}),
      }),
    ),
  };
}

/** Historical binding/native/replay data remains; only exact executable references retire. */
export function runtimeReleaseRetired(
  home: string,
  binding: RuntimeBinding,
  budget?: CollectionBudget,
): boolean {
  const raw = optionalRecord(receiptFile(home, binding.runtime_id), 4096, budget);
  if (!raw) return false;
  const receipt = receiptSchema.parse(raw);
  const current = evidence(home, binding, budget);
  return (
    !!current &&
    receipt.home === realpathSync(home) &&
    receipt.runtime === binding.runtime_id &&
    receipt.evidence === current.digest &&
    receipt.ended_boot !== null
  );
}

/** Owner/launch/dispatch exclusion plus an earlier durable fence and a new kernel boot. */
export async function retireRuntimeRelease(
  home: string,
  runtimes: Pick<RuntimeStore, 'get'>,
  id: string,
  boot: string,
  requireCurrent: () => void,
  run: CompilationCommandRunner,
  budget: CollectionBudget,
  write: typeof atomicPrivateJson = atomicPrivateJson,
): Promise<void> {
  const claims = acquireRuntimeRetirementClaims(home, id);
  try {
    requireCurrent();
    const binding = runtimes.get(id);
    if (!binding) throw new Error('Runtime binding disappeared');
    const current = evidence(home, binding, budget);
    if (!current) return;
    // Memory credit needs process exit and a durable launch fence, not the
    // later-boot descendant proof used for executable/raw-history collection.
    retireRuntimeMemoryGrant(home, runtimeBindingIdentity(binding), claims);
    const file = receiptFile(home, id);
    const raw = optionalRecord(file, 4096, budget);
    const previous = raw ? receiptSchema.parse(raw) : null;
    if (
      previous &&
      (previous.home !== realpathSync(home) ||
        previous.runtime !== id ||
        previous.evidence !== current.digest)
    )
      throw new Error('Runtime release retirement evidence changed');
    if (previous?.ended_boot) return;
    if (
      current.service &&
      current.service.kind !== 'detached' &&
      !(await serviceIsRemoved(home, { ...current.service, kind: current.service.kind }, run))
    )
      return;
    requireCurrent();
    if (
      JSON.stringify(runtimes.get(id)) !== JSON.stringify(binding) ||
      evidence(home, binding, budget)?.digest !== current.digest
    )
      throw new Error('Runtime changed during retirement');
    // Flush the existing delayed-launch fence before recording its boot identity.
    syncPrivateDirectory(current.directory);
    const next = receiptSchema.parse(
      previous
        ? { ...previous, ended_boot: previous.fence_boot === boot ? null : boot }
        : {
            format: 1,
            home: realpathSync(home),
            runtime: id,
            evidence: current.digest,
            fence_boot: boot,
            ended_boot: null,
          },
    );
    if (JSON.stringify(next) !== JSON.stringify(previous))
      write(file, next, { syncDirectory: true });
  } finally {
    claims.release();
  }
}
