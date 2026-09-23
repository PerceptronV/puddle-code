import { randomUUID } from 'node:crypto';
import { CONNECTION_POLICY, resourceIdSchema } from '@puddle/shared';
import { digest, secret } from '@puddle/shared/node';

interface Resource {
  until: number;
  close: () => void;
}
interface Lease {
  profile?: string;
  id: string;
  until: number;
  rotatedAt: number;
  tokens: Map<string, number>;
  resources: Map<string, Resource>;
  used: Set<string>;
}
export interface AuthorityResource {
  readonly profile?: string;
  valid(): boolean;
  release(): void;
}

/** In-memory host authority. Only the private control connection owns a lease id. */
export class LeaseRegistry {
  private readonly leases = new Map<string, Lease>();
  private readonly tokens = new Map<string, Lease>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly now = () => performance.now()) {
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  create(profile?: string): { generation: string; token: string } {
    const lease: Lease = {
      profile,
      id: randomUUID(),
      until: this.now() + CONNECTION_POLICY.leaseMs,
      rotatedAt: this.now(),
      tokens: new Map(),
      resources: new Map(),
      used: new Set(),
    };
    this.leases.set(lease.id, lease);
    return { generation: lease.id, token: this.rotate(lease) };
  }
  renew(id: string, resources: string[]): { generation: string; token?: string } | null {
    const lease = this.leases.get(id);
    if (!lease || !this.live(lease)) return null;
    // Bound duplicate-id tombstones without leaving a busy cockpit permanently
    // unusable: the control client recovers with a fresh generation.
    if (lease.used.size >= 100_000) {
      this.revoke(id);
      return null;
    }
    lease.until = this.now() + CONNECTION_POLICY.leaseMs;
    for (const id of resources) {
      const resource = lease.resources.get(id);
      // A late heartbeat cannot resurrect an expired stream, even if its timer was delayed.
      if (resource && resource.until > this.now()) resource.until = lease.until;
    }
    const token =
      this.now() - lease.rotatedAt >= CONNECTION_POLICY.rotationMs ? this.rotate(lease) : undefined;
    this.sweep();
    return { generation: id, ...(token ? { token } : {}) };
  }
  valid(token: string): boolean {
    return this.lookup(token) !== null;
  }
  attach(token: string, id: string, close: () => void): AuthorityResource | null {
    const lease = this.lookup(token);
    if (
      !lease ||
      !resourceIdSchema.safeParse(id).success ||
      lease.used.has(id) ||
      lease.used.size >= 100_000 ||
      lease.resources.size >= 2048
    )
      return null;
    lease.used.add(id);
    const resource: Resource = {
      until: Math.min(lease.until, lease.tokens.get(digest(token))!),
      close,
    };
    lease.resources.set(id, resource);
    return {
      profile: lease.profile,
      valid: () => {
        const ok =
          this.live(lease) && lease.resources.get(id) === resource && resource.until > this.now();
        if (!ok && lease.resources.delete(id)) close();
        return ok;
      },
      release: () => {
        lease.resources.delete(id);
      },
    };
  }
  revoke(id: string): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    for (const hash of lease.tokens.keys()) this.tokens.delete(hash);
    const resources = [...lease.resources.values()];
    lease.resources.clear();
    for (const resource of resources) resource.close();
  }
  sweep(): void {
    for (const lease of this.leases.values()) {
      if (!this.live(lease)) continue;
      for (const [hash, until] of lease.tokens) {
        if (until <= this.now()) {
          lease.tokens.delete(hash);
          this.tokens.delete(hash);
        }
      }
      for (const [id, resource] of lease.resources) {
        if (resource.until <= this.now()) {
          lease.resources.delete(id);
          resource.close();
        }
      }
    }
  }
  dispose(): void {
    clearInterval(this.timer);
    for (const id of this.leases.keys()) this.revoke(id);
  }
  private live(lease: Lease): boolean {
    if (!this.leases.has(lease.id)) return false;
    if (lease.until > this.now()) return true;
    this.revoke(lease.id);
    return false;
  }
  private lookup(token: string): Lease | null {
    if (!/^cn_[a-f0-9]{64}$/.test(token)) return null;
    const hash = digest(token);
    const lease = this.tokens.get(hash);
    return lease && this.live(lease) && (lease.tokens.get(hash) ?? 0) > this.now() ? lease : null;
  }
  private rotate(lease: Lease): string {
    const token = secret('cn_');
    const hash = digest(token);
    lease.tokens.set(hash, this.now() + CONNECTION_POLICY.tokenMs);
    this.tokens.set(hash, lease);
    lease.rotatedAt = this.now();
    return token;
  }
}
