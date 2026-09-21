import { CONNECTION_POLICY } from '@puddle/shared';
import { secret } from '@puddle/shared/node';

/** One outstanding challenge. Captured replies cannot be stockpiled to renew later. */
export class Participation {
  private pending: { nonce: string; at: number } | null = null;
  private until: number;
  constructor(private readonly now = () => performance.now()) {
    this.until = this.now() + CONNECTION_POLICY.leaseMs;
  }
  valid(): boolean {
    return this.now() < this.until;
  }
  challenge(): string | null {
    if (!this.valid()) return null;
    if (this.pending && this.now() - this.pending.at < CONNECTION_POLICY.participationMs)
      return null;
    this.pending = { nonce: secret(), at: this.now() };
    return this.pending.nonce;
  }
  accept(nonce: string): number | null {
    const pending = this.pending;
    if (
      !this.valid() ||
      !pending ||
      pending.nonce !== nonce ||
      this.now() - pending.at >= CONNECTION_POLICY.participationMs
    )
      return null;
    this.pending = null;
    this.until = pending.at + CONNECTION_POLICY.leaseMs;
    return pending.at;
  }
}
