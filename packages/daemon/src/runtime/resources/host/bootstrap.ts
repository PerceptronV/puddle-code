import type { RuntimeIdentity } from '@puddle/shared';
import { HostMemoryLedger } from './ledger.js';
import { initialHostMemoryCapacity, runtimeEssentialMemoryBytes } from './policy.js';

/** Must run before taking daemon-controller; initialisation proves no older launches exist. */
export function initialiseRuntimeMemory(home: string): void {
  HostMemoryLedger.initialise(home, initialHostMemoryCapacity()).close();
}

/** Launch intent is durable first; admission is durable before any process dispatch. */
export function reserveRuntimeLaunchMemory(
  home: string,
  identity: RuntimeIdentity,
  launchBytes: number,
): void {
  const ledger = HostMemoryLedger.openExisting(home);
  if (!ledger) throw new Error('Host runtime memory accounting is not initialised');
  try {
    // A launch id is single-use. Existing credit can only be observed/recovered
    // by its owner, never overwritten by another dispatch attempt.
    if (ledger.readGrant(identity)) throw new Error('Runtime memory admission already exists');
    if (!ledger.compareGrant(identity, 0, runtimeEssentialMemoryBytes(launchBytes)))
      throw new Error('Host runtime memory capacity is exhausted');
  } finally {
    ledger.close();
  }
}
