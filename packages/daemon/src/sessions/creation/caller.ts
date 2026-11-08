import type { RuntimeIdentity } from '@puddle/shared';

/** Private host caller hooks. Record/bind execute inside the existing DB transactions. */
export interface SessionCreationCaller {
  /** Stable digest of the caller's exact retained intent; never a callback serialisation. */
  readonly identity: string;
  check(): void;
  record(sessionId: string): void;
  bind(identity: RuntimeIdentity): void;
}
