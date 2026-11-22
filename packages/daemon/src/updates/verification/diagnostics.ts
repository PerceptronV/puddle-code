import { hostUpdateBlockerMessage, type HostUpdateReview } from '@puddle/shared';

const adoptionBlockerCodes = [
  'runtime_persistence_pending',
  'runtime_reconciliation_pending',
  'runtime_adoption_changed',
  'runtime_unavailable',
  'daemon_adoption_unconfirmed',
  'daemon_release_changed',
  'adoption_evidence_unavailable',
] as const;
export type AdoptionBlockerCode = (typeof adoptionBlockerCodes)[number];

/** Keep trusted codes separate from arbitrary filesystem/service error messages. */
export class HostUpdateVerificationBlocked extends Error {
  constructor(
    readonly blockers: HostUpdateReview['blockers'],
    readonly more = 0,
  ) {
    const code = adoptionBlockerCodes.find((known) => known === blockers[0]?.code);
    super(hostUpdateBlockerMessage(code ?? 'adoption_evidence_unavailable'));
  }

  review(): HostUpdateReview {
    return {
      fingerprint: null,
      can_apply: false,
      blockers: this.blockers.slice(0, 32),
      more_blockers: this.more + Math.max(0, this.blockers.length - 32),
      affected: { terminals: 0, notebooks: 0, compilation: 0, programmes: 0 },
    };
  }
}

export function adoptionBlocked(code: AdoptionBlockerCode, target = 'daemon'): never {
  throw new HostUpdateVerificationBlocked([{ code, target }]);
}

export function updateFailureMessage(error: unknown): string {
  return error instanceof HostUpdateVerificationBlocked
    ? error.message
    : 'Host activation or verification requires inspection';
}
