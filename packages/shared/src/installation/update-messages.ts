/** Public explanations use fixed text; private blocker targets never enter browser copy. */
export function hostUpdateBlockerMessage(code: string): string {
  switch (code) {
    case 'runtime_persistence_pending':
      return 'A runtime cannot confirm saved state. Inspect the affected session before retrying. Stopping it interrupts its agents and shell jobs and requires your approval.';
    case 'runtime_reconciliation_pending':
      return 'A runtime has not finished reconnecting and saving its observations. Check its session, then verify completion again.';
    case 'runtime_adoption_changed':
      return 'A runtime no longer matches the saved takeover checkpoint. Inspect its session before continuing recovery.';
    case 'runtime_unavailable':
      return 'A runtime cannot be inspected. Check its session and host connection before retrying.';
    case 'daemon_adoption_unconfirmed':
      return 'The replacement daemon has not proved takeover of the saved runtimes. Inspect host update status before continuing recovery.';
    case 'daemon_release_changed':
      return 'The running daemon does not match the exact approved release. Inspect the selected release before continuing recovery.';
    case 'adoption_evidence_unavailable':
      return 'The saved takeover evidence could not be inspected. Check the host update logs; do not repeat installation.';
    case 'runtime_lifetime_unverified':
      return 'A runtime has a limited or unverified host lifetime. Daemon replacement is blocked while it runs. Updating also requires a supported host service manager.';
    default:
      return `Check failed: ${(code === 'cockpit_incompatible' ? 'frontend_incompatible' : code).replaceAll('_', ' ')}`;
  }
}
