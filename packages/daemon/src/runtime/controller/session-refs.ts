import { join } from 'node:path';
import { runtimeLaunchSchema } from '@puddle/shared';
import type { RuntimeStore } from '../../db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../transport/connections.js';
import { readRuntimeJson, runtimeDirectory } from '../ownership/storage.js';

/** Private launch evidence only; catalogue recency never identifies a live conversation. */
export function runtimePriorRefs(
  home: string,
  runtimes: RuntimeStore,
  sessionId: string,
): ReadonlySet<string> | undefined {
  const binding = runtimes.selectedOwner(sessionId);
  if (!binding) return undefined;
  const launch = runtimeLaunchSchema.parse(
    readRuntimeJson(join(runtimeDirectory(home, binding.runtime_id), 'launch.json')),
  );
  const identity = runtimeBindingIdentity(binding);
  if (
    Object.entries(identity).some(
      ([key, value]) => launch.identity[key as keyof typeof identity] !== value,
    )
  )
    throw new Error('Runtime launch identity changed');
  return launch.provider?.prior_refs === undefined
    ? undefined
    : new Set(launch.provider.prior_refs);
}
