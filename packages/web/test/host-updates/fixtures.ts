import type { FrontendHostUpdateReply, FrontendHostUpdateStatus } from '@puddle/shared';

export function statusFixture(): FrontendHostUpdateStatus {
  return {
    availability: 'ready',
    daemon_version: '0.4.0',
    capabilities: { interruption_approval: true, verify_completion: true, continue_recovery: true },
    result: { ok: true, operation: null },
    catalogue: {
      observed_at: 1000,
      daemon_version: '0.4.0',
      runtime_default: { version: '0.3.14', protocol: { major: 1, minor: 0 } },
      runtimes: { complete: true, versions: [] },
      releases: {
        repository: 'example/puddle',
        state: 'ready',
        checked_at: 1000,
        succeeded_at: 1000,
        latest: { version: '0.4.1', host_asset: true },
      },
    },
  };
}

export function reviewFixture(
  interruption = false,
): Extract<FrontendHostUpdateReply, { ok: true }> {
  return {
    ok: true,
    operation: {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 3,
      created_at: 1000,
      updated_at: 1000,
      phase: 'preflight',
      targets: [{ component: 'daemon', version: '0.4.1' }],
      staged: true,
      dispatched: false,
      message: null,
    },
    review: {
      fingerprint: interruption ? null : 'a'.repeat(64),
      can_apply: !interruption,
      ...(interruption ? { interruption_fingerprint: 'b'.repeat(64) } : {}),
      blockers: interruption ? [{ code: 'interruption_approval_required' }] : [],
      more_blockers: 0,
      affected: {
        terminals: interruption ? 2 : 0,
        notebooks: interruption ? 1 : 0,
        compilation: 0,
        programmes: 0,
      },
    },
  };
}
