import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type HostUpdateOperation,
  type HostUpdateReview,
} from '../../src/index.js';

export function reviewedHostUpdate() {
  const fingerprint = 'a'.repeat(64);
  const operation: HostUpdateOperation = {
    format: 1,
    id: randomUUID(),
    revision: 2,
    created_at: 1,
    updated_at: 2,
    phase: 'preflight',
    targets: [{ component: 'daemon', version: '0.4.0' }],
    stages: [
      {
        digest: fingerprint,
        record: {
          format: 1,
          component: 'daemon',
          version: '0.4.0',
          generation: '0.4.0~ABC123',
          protocol: { ...PROTOCOL_VERSION },
          archive_sha256: fingerprint,
          tree_sha256: fingerprint,
          checksum_verified: true,
        },
      },
    ],
    preflight: fingerprint,
    approved: null,
    dispatch_id: null,
    worker_id: null,
    verification: null,
    message: null,
  };
  const review: HostUpdateReview = {
    fingerprint: null,
    interruption_fingerprint: fingerprint,
    can_apply: false,
    blockers: [{ code: 'interruption_approval_required', target: 'host' }],
    more_blockers: 0,
    affected: { terminals: 2, notebooks: 1, compilation: 3, programmes: 4 },
  };
  return { operation, review };
}
