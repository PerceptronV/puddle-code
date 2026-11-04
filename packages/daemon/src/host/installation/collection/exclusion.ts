import { acquireHostClaim } from '../../../security/claims.js';
import type { ReleaseCollectionGuard } from './guard.js';

/** One writer claim spans reference inspection and every resulting filesystem effect. */
export async function withReleaseCollectionExclusion<T>(
  guard: ReleaseCollectionGuard,
  authorised: () => boolean,
  work: (requireCurrent: () => void) => Promise<T>,
): Promise<T> {
  const deadline = performance.now() + 30_000;
  const requireCurrent = () => {
    guard.requireController();
    if (!authorised()) throw new Error('Release collection authority expired');
    if (performance.now() > deadline)
      throw new Error('Release collection review deadline exceeded');
  };
  requireCurrent();
  const control = acquireHostClaim(guard.home, 'host-update-control');
  try {
    return await work(requireCurrent);
  } finally {
    control.release();
  }
}
