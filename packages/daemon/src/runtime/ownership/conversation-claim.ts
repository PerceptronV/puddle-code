import { acquireHostClaim, HostClaimBusy } from '../../security/claims.js';

/** Runtime-owned exclusion remains effective without a daemon/controller. */
export class RuntimeConversationClaim {
  private current: { ref: string; release(): void } | null = null;

  constructor(
    private readonly home: string,
    private readonly profile: string,
    private readonly provider: string,
  ) {}

  switch(ref: string): boolean {
    if (this.current?.ref === ref) return true;
    let next: ReturnType<typeof acquireHostClaim>;
    try {
      // Tuple encoding avoids delimiter ambiguity; account is intentionally not
      // part of conversation identity because profiles can share native stores.
      next = acquireHostClaim(
        this.home,
        `conversation:${JSON.stringify([this.profile, this.provider, ref])}`,
      );
    } catch (error) {
      if (error instanceof HostClaimBusy) return false;
      throw error;
    }
    const previous = this.current;
    this.current = { ref, release: next.release };
    previous?.release();
    return true;
  }

  close(): void {
    this.current?.release();
    this.current = null;
  }
}
