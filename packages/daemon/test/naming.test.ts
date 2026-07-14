import { describe, expect, it } from 'vitest';
import { wordPairName } from '../src/worktrees/names.js';
import { promptSlug, slugify } from '../src/worktrees/slug.js';

describe('branch naming', () => {
  it('slugifies titles branch-safely', () => {
    expect(slugify('Fix flaky auth test!')).toBe('fix-flaky-auth-test');
  });

  it('cuts prompt slugs at a word boundary', () => {
    expect(promptSlug('fix the flaky auth test in the CI pipeline please')).toBe(
      'fix-the-flaky-auth-test-in',
    );
    expect(promptSlug('short task')).toBe('short-task');
    expect(promptSlug(null)).toBe('');
  });

  it('falls back to a memorable word pair, never a uuid fragment', () => {
    for (let i = 0; i < 20; i++) {
      expect(wordPairName()).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });
});
