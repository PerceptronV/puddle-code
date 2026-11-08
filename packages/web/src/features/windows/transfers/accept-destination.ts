import type { DesktopTransferReference, DesktopWindowTransfersBridge } from '@puddle/shared';

/** A lost destination reply may follow a durable commit and source closure. */
export async function acceptDestination(
  bridge: Pick<DesktopWindowTransfersBridge, 'accept' | 'observe'>,
  reference: DesktopTransferReference,
) {
  try {
    return await bridge.accept(reference);
  } catch (error) {
    const observed = await bridge.observe(reference).catch(() => null);
    if (observed?.status === 'committed' && observed.version) return observed.version;
    // Cancellation belongs to the coordinator's rollback command. Uncertain
    // outcomes remain fenced for recovery; never repeat acceptance or the move.
    throw error;
  }
}
