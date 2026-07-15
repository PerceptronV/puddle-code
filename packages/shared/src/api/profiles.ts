import { z } from 'zod';
import { isoTimestamp, profileId } from './common.js';

/** Filesystem-safe: profile names become directory names under ~/.puddle/profiles/. */
export const fsSafeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dot, underscore and hyphen only');

/** Default branch prefix for a new profile; editable per profile in settings. */
export const DEFAULT_BRANCH_PREFIX = 'puddle/';

/** Where the repo's standing rules are spliced into the onboarding template. */
export const RULES_TOKEN = '{{rules}}';

/**
 * Built-in launch text for a freshly created worktree (SPEC §4), used when the
 * profile has not set `onboardingTemplate`. `{{rules}}` is replaced with the
 * repo's user-authored standing rules. Editable per profile in Settings →
 * Sessions, where it may also be cleared to an empty preamble.
 */
export const DEFAULT_ONBOARDING_TEMPLATE = `[puddle onboarding] This is a freshly created git worktree for this task. Before starting, set up the environment:

1. Standing setup rules for this repository (user-authored):
${RULES_TOKEN}

2. Inspect the codebase for setup requirements (README, CONTRIBUTING, lockfiles, .tool-versions, pyproject.toml, package.json, …).
3. Apply what the rules above settle without asking. Ask the user about anything they leave open, stating trade-offs where relevant (e.g. a symlinked .venv saves gigabytes per worktree, but parallel sessions then share mutable dependency state).
4. If the user states a standing rule for all future worktrees ("always…", "never…", "from now on…"), write the complete updated rules to \`.puddle/onboarding-notes.md\` in this worktree — full replacement, user-owned prose; record their decision, don't invent policy.

Then proceed with the task below (or await instructions if none is given).`;

/** Built-in launch text for joining an existing/shared worktree (SPEC §4). */
export const DEFAULT_CONCURRENT_TEMPLATE = `[puddle] You are joining an existing branch and worktree that other agents may be working in concurrently. Files can change underneath you, so re-check the working tree before you act, and avoid disruptive git operations (resetting, force-pushing, or deleting the branch) that would disrupt work already in progress by others.`;

export const profileSchema = z.object({
  id: profileId,
  name: fsSafeName,
  branch_prefix: z.string(),
  created_at: isoTimestamp,
});
export type Profile = z.infer<typeof profileSchema>;

export const createProfileRequestSchema = z.object({
  name: fsSafeName,
  branch_prefix: z.string().max(64).optional(),
});

/**
 * PATCH /api/profiles/:id — update the display `name` and/or the `branch_prefix`.
 * Both are optional (send only what changes). The name is a display label and
 * keys nothing on disk (dirs are id-keyed), so it is freely editable; it stays
 * `fsSafeName`-constrained and unique across profiles (a clash returns 409).
 */
export const patchProfileRequestSchema = z.object({
  name: fsSafeName.optional(),
  branch_prefix: z.string().max(64).optional(),
});

/**
 * Profile-scope settings JSON. Loose: later phases add keys (default account,
 * notifications, …) without a daemon migration. Phase 1 validates only the gate.
 */
export const profileSettingsSchema = z.looseObject({
  allowSkipPermissions: z.boolean().default(false),
  /**
   * Launch-text templates (SPEC §4). A key that is ABSENT falls back to the
   * daemon's built-in default; an EMPTY string is an intentional empty preamble.
   * `onboardingTemplate` (freshly created worktree) supports a `{{rules}}` token
   * where the repo's onboarding notes are injected; `concurrentTemplate` is used
   * when a session joins an existing/shared worktree.
   */
  onboardingTemplate: z.string().optional(),
  concurrentTemplate: z.string().optional(),
  /**
   * The user's drag-order of projects on the homescreen (project ids). Projects
   * absent from this list — newly created ones — sort to the top. The right
   * sidebar's cross-project grouping inherits this order (SPEC §11, §12).
   */
  projectOrder: z.array(z.string()).optional(),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const patchProfileSettingsRequestSchema = z.record(z.string(), z.unknown());
