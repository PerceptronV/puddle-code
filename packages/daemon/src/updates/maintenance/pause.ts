import type { HostAdmission } from '../../host/lifecycle/admission.js';

type Hold = ReturnType<HostAdmission['pause']>;
type Participant = Pick<HostAdmission, 'pause'>;

/** A final inspection hold, distinct from the durable checkpoint produced by shutdown. */
export class HostUpdatePause {
  private held = false;
  constructor(private readonly phases: readonly (readonly Participant[])[]) {}

  async acquire(timeoutMs = 30_000): Promise<{ release(): void }> {
    if (this.held) throw new Error('Host update inspection is already paused');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
      throw new Error('Invalid host update pause deadline');
    this.held = true;
    const holds: Hold[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const errors: unknown[] = [];
      // Restore observation before allowing new launches and client work.
      for (const hold of holds.reverse()) {
        try {
          hold.release();
        } catch (error) {
          errors.push(error);
        }
      }
      this.held = false;
      if (errors.length) throw new AggregateError(errors, 'Host update pause release failed');
    };
    const deadline = performance.now() + timeoutMs;
    try {
      for (const phase of this.phases) {
        const admitted: Hold[] = [];
        // Close this phase synchronously, before any admitted writer can yield back.
        for (const participant of phase) {
          const hold = participant.pause();
          holds.push(hold);
          admitted.push(hold);
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error('Host update pause deadline reached');
        const results = await Promise.allSettled(
          admitted.map((hold) => Promise.resolve().then(() => hold.drain(remaining))),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      return { release };
    } catch (error) {
      try {
        release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'Host update inspection did not resume', {
          cause: releaseError,
        });
      }
      throw error;
    }
  }
}
