import { acquireHostClaim } from '../../../../security/claims.js';

/** Hold every delayed-launch and owner boundary while inspecting or retiring a runtime. */
export function acquireRuntimeRetirementClaims(home: string, id: string): { release(): void } {
  const claims: Array<{ release(): void }> = [];
  const release = () => {
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
    for (const scope of [`runtime-launch:${id}`, `runtime-dispatch:${id}`, `runtime:${id}`])
      claims.push(acquireHostClaim(home, scope));
    return { release };
  } catch (error) {
    try {
      release();
    } catch {
      /* Preserve the acquisition error after attempting every close. */
    }
    throw error;
  }
}
