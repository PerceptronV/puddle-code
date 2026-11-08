import type { RuntimeIdentity } from '@puddle/shared';

/** Private host caller hooks. Record/bind execute inside the existing DB transactions. */
export interface SessionLaunchCaller {
  /** Stable digest of the caller's exact retained intent; never a callback serialisation. */
  readonly identity: string;
  check(): void;
  bind(identity: RuntimeIdentity): void;
}

export interface SessionCreationCaller extends SessionLaunchCaller {
  record(sessionId: string): void;
}
