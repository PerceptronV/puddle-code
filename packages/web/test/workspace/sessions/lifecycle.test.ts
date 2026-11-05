import { describe, expect, it } from 'vitest';
import { sessionStatusSchema } from '@puddle/shared';
import { sessionLifecycle } from '../../../src/features/workspace/sessions/lifecycle';

describe('shared session lifecycle eligibility', () => {
  for (const status of sessionStatusSchema.options) {
    it(`handles ${status} with every missing-resource combination`, () => {
      for (const worktree_missing of [false, true]) {
        for (const conversation_missing of [false, true]) {
          const result = sessionLifecycle({ status, worktree_missing, conversation_missing });
          expect(result.live).toBe(['starting', 'running', 'waiting_input'].includes(status));
          expect(result.archived).toBe(status === 'archived');
          expect(result.resumable).toBe(
            ['exited', 'interrupted'].includes(status) &&
              !worktree_missing &&
              !conversation_missing,
          );
          expect(result.resumeUnavailable).toBe(
            worktree_missing
              ? 'Worktree directory is gone — resume unavailable'
              : conversation_missing
                ? 'Native conversation is missing — resume unavailable'
                : undefined,
          );
        }
      }
    });
  }
});
