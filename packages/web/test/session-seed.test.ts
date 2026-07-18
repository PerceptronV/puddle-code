import { describe, expect, it } from 'vitest';
import { profileSettingsSchema } from '@puddle/shared';
import { resolveSessionSeed } from '../src/features/workspace/session-seed';

const settings = (sessionDefaults: unknown) => profileSettingsSchema.parse({ sessionDefaults });

describe('resolveSessionSeed', () => {
  it('falls back to the built-ins when nothing is stored', () => {
    expect(resolveSessionSeed('agent', undefined)).toEqual({
      baseBranch: '',
      separateBranch: true,
      separateWorktree: true,
    });
    expect(resolveSessionSeed('terminal', profileSettingsSchema.parse({}))).toEqual({
      baseBranch: '',
      separateBranch: false,
      separateWorktree: false,
    });
  });

  it('applies stored per-kind defaults', () => {
    const s = settings({
      agent: { baseBranch: 'develop', separateBranch: false, separateWorktree: true },
      terminal: { separateBranch: true },
    });
    expect(resolveSessionSeed('agent', s)).toEqual({
      baseBranch: 'develop',
      separateBranch: false,
      separateWorktree: true,
    });
    // Terminal keeps its own built-ins for unset fields.
    expect(resolveSessionSeed('terminal', s).baseBranch).toBe('');
  });

  it('a separate branch forces a separate directory, whatever is stored', () => {
    const s = settings({ agent: { separateBranch: true, separateWorktree: false } });
    expect(resolveSessionSeed('agent', s).separateWorktree).toBe(true);
  });

  it('one kind never inherits the other kind’s stored values', () => {
    const s = settings({ agent: { baseBranch: 'develop' } });
    expect(resolveSessionSeed('terminal', s).baseBranch).toBe('');
  });
});
