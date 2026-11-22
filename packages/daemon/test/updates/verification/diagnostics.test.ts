import { expect, it } from 'vitest';
import { presentHostUpdate } from '@puddle/shared';
import {
  HostUpdateVerificationBlocked,
  updateFailureMessage,
} from '../../../src/updates/verification/diagnostics.js';

it('persists only fixed diagnostic copy and strips private targets from frontend replies', () => {
  const error = new HostUpdateVerificationBlocked([
    { code: 'runtime_persistence_pending', target: '/private/host/runtime' },
  ]);
  expect(updateFailureMessage(error)).toContain('cannot confirm saved state');
  expect(updateFailureMessage(error)).not.toContain('/private');
  expect(
    updateFailureMessage(
      new HostUpdateVerificationBlocked([{ code: '/private/future-error', target: 'daemon' }]),
    ),
  ).not.toContain('/private');
  expect(updateFailureMessage(new Error('/private/host/secret'))).toBe(
    'Host activation or verification requires inspection',
  );
  const publicReply = presentHostUpdate(
    { ok: true, operation: null, review: error.review() },
    { redactMessage: true },
  );
  expect(publicReply).toMatchObject({
    ok: true,
    review: {
      can_apply: false,
      fingerprint: null,
      blockers: [{ code: 'runtime_persistence_pending' }],
    },
  });
  expect(JSON.stringify(publicReply)).not.toContain('/private');
});
