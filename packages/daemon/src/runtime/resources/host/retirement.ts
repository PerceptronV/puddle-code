import type { RuntimeIdentity } from '@puddle/shared';
import type { RuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { HostMemoryLedger } from './ledger.js';

/** Existing ownership/lifetime claims must remain held through this synchronous retirement. */
export function retireRuntimeMemoryGrant(
  home: string,
  identity: RuntimeIdentity,
  claims: RuntimeRetirementClaims,
): void {
  claims.requireCurrent(home, identity.runtime_id);
  const ledger = HostMemoryLedger.openExisting(home);
  if (!ledger) return;
  try {
    ledger.retireGrant(identity, claims);
  } finally {
    ledger.close();
  }
}

/** Purge must not delete the launch/fence evidence needed to reclaim any surviving grant. */
export function requireNoRuntimeMemoryGrants(home: string): void {
  const ledger = HostMemoryLedger.openExisting(home);
  if (!ledger) return;
  try {
    ledger.requireEmpty();
  } finally {
    ledger.close();
  }
}
