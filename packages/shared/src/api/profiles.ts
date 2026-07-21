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

/**
 * Built-in launch text sent when a session is resumed after an INTERRUPTION —
 * a daemon restart or a machine reboot (SPEC §4). Any processes the agent had
 * started are gone, so the default asks it to re-verify its environment.
 * Editable per profile in Settings → Sessions; an empty string sends nothing.
 */
export const DEFAULT_RESTART_TEMPLATE = `This session was interrupted (daemon or machine restart). Processes you started are gone; re-verify your environment before continuing.`;

/**
 * The variables a `tabTitleTemplate` may interpolate (`${name}` style), in the
 * order the settings UI lists them. Each maps a token to a one-line description
 * of what it resolves to for a session (SPEC §4). The renderer lives in the web
 * package; this list is the shared source the settings editor documents.
 */
export const TAB_TITLE_VARIABLES = [
  ['name', 'the resolved display name: user rename, else agent name, else sequence, else id'],
  ['title', 'the user rename override only (empty when unset)'],
  ['agentName', "the agent's own session name (empty when the agent has not named it)"],
  ['sequence', 'the terminal-title name the process set (empty when it set none)'],
  ['branch', 'the git branch'],
  ['cwd', "the worktree directory's name"],
  ['id', 'the first 8 characters of the session id'],
  ['status', 'the session status (running, waiting_input, …)'],
  ['agent', 'the agent type (empty for terminal sessions)'],
  ['separator', 'an em dash that appears only between two non-empty neighbours'],
] as const;

/**
 * Default tab-title template (SPEC §4). `${name}` is the smart fallback chain,
 * so the default reproduces the historical display name; users override this per
 * profile to add decoration (e.g. `${branch}${separator}${name}`).
 */
export const DEFAULT_TAB_TITLE_TEMPLATE = '${name}';

/**
 * The colour keys a profile icon may use (SPEC §11): theme-aware tokens the web
 * maps to `text-*` classes, so the glyph recolours with the theme and adds no
 * raw colours. `null`/absent → the default heading colour.
 */
export const PROFILE_ICON_COLOURS = [
  'navy',
  'gold',
  'blue',
  'green',
  'red',
  'violet',
  'cyan',
] as const;

export const profileSchema = z.object({
  id: profileId,
  name: fsSafeName,
  branch_prefix: z.string(),
  /** Lucide icon name (kebab-case, e.g. `rocket`); null → the default person glyph. */
  icon: z.string().nullable().default(null),
  /** A `PROFILE_ICON_COLOURS` key; null → the default heading colour. */
  icon_colour: z.string().nullable().default(null),
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
  /** Set/clear the profile's lucide icon (kebab-case name); null clears it. */
  icon: z.string().max(64).nullable().optional(),
  /** Set/clear the icon colour (a `PROFILE_ICON_COLOURS` key); null clears it. */
  icon_colour: z.string().max(32).nullable().optional(),
});

/** One kind's new-session seed (all optional — absent falls back to built-ins). */
const sessionSeedSchema = z.looseObject({
  baseBranch: z.string().optional(),
  separateBranch: z.boolean().optional(),
  separateWorktree: z.boolean().optional(),
});
export const sessionDefaultsSchema = z.looseObject({
  agent: sessionSeedSchema.optional(),
  terminal: sessionSeedSchema.optional(),
});
export type SessionDefaults = z.infer<typeof sessionDefaultsSchema>;

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
   * when a session joins an existing/shared worktree; `restartTemplate` is sent
   * when a session is resumed after a daemon restart or machine reboot.
   */
  onboardingTemplate: z.string().optional(),
  concurrentTemplate: z.string().optional(),
  restartTemplate: z.string().optional(),
  /**
   * How a session's tab/label is composed from its parts (SPEC §4). A template
   * string interpolating `${…}` variables (see `TAB_TITLE_VARIABLES`); ABSENT
   * falls back to `DEFAULT_TAB_TITLE_TEMPLATE` (`${name}`), reproducing the
   * historical display name. Empty renders (all chosen variables blank) fall
   * back to the session-id prefix, so a tab is never nameless.
   */
  tabTitleTemplate: z.string().optional(),
  /**
   * The user's drag-order of projects on the homescreen (project ids). Projects
   * absent from this list — newly created ones — sort to the top. The right
   * sidebar's cross-project grouping inherits this order (SPEC §11, §12).
   */
  projectOrder: z.array(z.string()).optional(),
  /**
   * Seed defaults for the new-session modal, per kind (SPEC §11). An absent
   * key falls back to the built-ins — agents branch off the base in their own
   * directory; terminals share the base branch's directory. `baseBranch`
   * absent or empty means the repository's default base branch. The modal
   * still enforces that a separate branch always gets its own directory.
   */
  sessionDefaults: sessionDefaultsSchema.optional(),
  /**
   * Per-profile keyboard-shortcut overrides (SPEC §11): action-id → canonical
   * binding string (e.g. `meta+shift+KeyE`). Absent keys use the app default;
   * the web owns the action registry and the binding format.
   */
  hotkeys: z.record(z.string(), z.string()).optional(),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

export const patchProfileSettingsRequestSchema = z.record(z.string(), z.unknown());
