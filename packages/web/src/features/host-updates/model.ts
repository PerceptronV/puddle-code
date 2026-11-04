import {
  hostUpdateTerminal,
  isNewerVersion,
  type CockpitHostUpdateReply,
  type CockpitHostUpdateRequest,
  type CockpitHostUpdateStatus,
  type HostUpdateTargets,
} from '@puddle/shared';

export type UpdateOperation = NonNullable<CockpitHostUpdateReply['operation']>;

export function availableHostUpdates(
  status: CockpitHostUpdateStatus | undefined,
): HostUpdateTargets {
  const catalogue = status?.catalogue;
  const latest = catalogue?.releases.latest;
  if (status?.availability !== 'ready' || !catalogue || !latest?.host_asset) return [];
  const targets: HostUpdateTargets = [];
  if (isNewerVersion(latest.version, catalogue.daemon_version))
    targets.push({ component: 'daemon', version: latest.version });
  if (
    catalogue.runtime_default &&
    isNewerVersion(latest.version, catalogue.runtime_default.version)
  )
    targets.push({ component: 'runtime', version: latest.version });
  return targets;
}

export function canReview(operation: UpdateOperation): boolean {
  return (
    operation.staged &&
    !operation.dispatched &&
    ['staged', 'preflight', 'approved'].includes(operation.phase)
  );
}

/** A review is usable only for the exact operation revision currently displayed. */
export function reviewedApply(
  status: CockpitHostUpdateStatus | undefined,
  reply: CockpitHostUpdateReply | undefined,
): Extract<CockpitHostUpdateRequest, { action: 'apply' }> | null {
  const current = status?.result?.operation;
  if (
    status?.availability !== 'ready' ||
    !status.result?.ok ||
    !current ||
    !canReview(current) ||
    !reply?.ok ||
    reply.operation?.id !== current.id ||
    reply.operation.revision !== current.revision
  )
    return null;
  const review = reply.review;
  if (!review) return null;
  const interruption = review.interruption_fingerprint;
  const fingerprint = review.fingerprint ?? interruption;
  if (!fingerprint || (!review.can_apply && !interruption)) return null;
  if (interruption && !status.capabilities.interruption_approval) return null;
  return {
    action: 'apply',
    reference: { id: current.id, revision: current.revision },
    fingerprint,
    ...(interruption ? { interruption_approval: interruption } : {}),
  };
}

export function updateInProgress(status: CockpitHostUpdateStatus | undefined): boolean {
  const operation = status?.result?.operation;
  return !!operation && !hostUpdateTerminal(operation.phase);
}

export function offlineRecoveryRequest(
  status: CockpitHostUpdateStatus,
): Extract<CockpitHostUpdateRequest, { action: 'continue-offline' }> | null {
  const operation = status.result?.operation;
  return status.availability === 'unavailable' &&
    status.observation === 'recorded' &&
    status.capabilities.offline_continuation &&
    status.result?.ok &&
    operation?.dispatched &&
    !hostUpdateTerminal(operation.phase)
    ? { action: 'continue-offline', reference: { id: operation.id, revision: operation.revision } }
    : null;
}

export const phaseLabel: Record<UpdateOperation['phase'], string> = {
  checking: 'Checking update',
  downloading: 'Downloading',
  staged: 'Downloaded and verified',
  preflight: 'Ready for review',
  approved: 'Approved',
  dispatching: 'Starting update',
  applying: 'Applying update',
  verifying: 'Verifying update',
  complete: 'Update complete',
  blocked: 'Update blocked',
  cancelled: 'Update cancelled',
  superseded: 'Update replaced',
  failed: 'Update failed',
  recovery_required: 'Recovery required',
  rolled_back: 'Update rolled back',
};

/** Kept by the window, outside React mounts; a new window gets a fresh ledger. */
export class HostUpdateOffers {
  private readonly offered = new Set<string>();

  take(host: string, targets: HostUpdateTargets): HostUpdateTargets {
    return targets.filter(({ component, version }) => {
      const key = JSON.stringify([host, component, version]);
      if (this.offered.has(key)) return false;
      this.offered.add(key);
      return true;
    });
  }
}
