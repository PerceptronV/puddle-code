import { realpathSync } from 'node:fs';
import { acquireHostClaim } from '../../security/claims.js';

const retirementProof: unique symbol = Symbol('runtime-retirement-claims');
export interface RuntimeRetirementClaims {
  readonly [retirementProof]: true;
  requireCurrent(home: string, id: string): void;
  release(): void;
}

/** Hold every delayed-launch and owner boundary while inspecting or retiring a runtime. */
export function acquireRuntimeRetirementClaims(home: string, id: string): RuntimeRetirementClaims {
  const claims: Array<{ release(): void }> = [];
  let released = false;
  const release = () => {
    released = true;
    let failure: { error: unknown } | undefined;
    for (const claim of claims.splice(0).reverse()) {
      try {
        claim.release();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  };
  try {
    for (const scope of [
      `runtime-launch:${id}`,
      `runtime-dispatch:${id}`,
      `runtime:${id}`,
      `runtime-memory:${id}`,
    ])
      claims.push(acquireHostClaim(home, scope));
    const root = realpathSync(home);
    return {
      [retirementProof]: true,
      release,
      requireCurrent(expectedHome, expectedId) {
        if (released || expectedId !== id || realpathSync(expectedHome) !== root)
          throw new Error('Runtime retirement claims are no longer held for this owner');
      },
    };
  } catch (error) {
    try {
      release();
    } catch {
      /* Preserve the acquisition error after attempting every close. */
    }
    throw error;
  }
}
