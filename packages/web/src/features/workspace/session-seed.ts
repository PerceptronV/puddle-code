import type { ProfileSettings, SessionKind } from '@puddle/shared';

/**
 * Resolves what the new-session modal opens WITH (SPEC §11): the profile's
 * per-kind `sessionDefaults`, falling back to the built-ins — agents branch
 * off the base in their own directory; terminals share the base branch's
 * directory. Pure and DOM-free — unit-testable.
 */

export interface SessionSeed {
  /** '' = the repository's default base branch. */
  baseBranch: string;
  separateBranch: boolean;
  separateWorktree: boolean;
}

const BUILT_IN: Record<SessionKind, SessionSeed> = {
  agent: { baseBranch: '', separateBranch: true, separateWorktree: true },
  terminal: { baseBranch: '', separateBranch: false, separateWorktree: false },
};

export function resolveSessionSeed(
  kind: SessionKind,
  settings: ProfileSettings | undefined,
): SessionSeed {
  const stored = settings?.sessionDefaults?.[kind];
  const builtIn = BUILT_IN[kind];
  const separateBranch = stored?.separateBranch ?? builtIn.separateBranch;
  return {
    baseBranch: stored?.baseBranch ?? builtIn.baseBranch,
    separateBranch,
    // A separate branch always gets its own directory (SPEC §4) — enforced
    // here too, so a contradictory stored pair cannot seed an invalid modal.
    separateWorktree: separateBranch
      ? true
      : (stored?.separateWorktree ?? builtIn.separateWorktree),
  };
}
