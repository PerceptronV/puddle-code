# Session naming, launch templates, right-click menu, and archived-session access

**Date:** 2026-07-14
**Status:** approved, ready for implementation

## Problem

Four related shortcomings in how puddle sessions are named, launched, acted on, and archived:

1. **Naming.** A session's display name defaults to the leading 8 hex chars of its UUID.
   Renaming is broken — a UI rename is silently reverted by the `.puddle/session-title`
   marker-file sync. And the marker file cannot work now that multiple agents may share one
   worktree (they collide on a single `.puddle/session-title`). The default name should
   instead be the agent's own session name (for Claude Code: the transcript title shown in
   its resume picker).
2. **Launch templates.** The onboarding/launch preambles ("new worktree" and "existing/shared
   worktree") are hardcoded in the daemon and not user-editable.
3. **Right-click.** The only way to act on a session (kill/rename/archive/…) is the hover
   ellipsis menu on an expanded-sidebar row. Right-clicking a session should open the same menu.
4. **Archive.** Archived sessions vanish from the UI entirely, so archive reads as deletion.
   Archiving must never make a session inaccessible — archived sessions should be reachable
   under a collapsible header.

## Findings (verified)

- Claude Code's process name is just `claude` — no session name there.
- Claude Code's transcript (`<config_dir>/projects/<escaped-cwd>/<ref>.jsonl`) carries the
  session's human-readable name: an `ai-title` entry (`{type:"ai-title", aiTitle:"…"}`,
  present in nearly every session after the first exchange) and, less often, an explicit
  `agent-name` entry (`{type:"agent-name", agentName:"…"}`). This is the name shown in the
  resume picker. Verified against Claude Code 2.1.210.
- Today `sessions.title` holds *both* user renames and agent-authored titles indistinguishably.
  The rename revert is the `MarkerFileSync.syncTitle` race (daemon/src/sessions/onboarding.ts).
- Profile-scope settings are a loose JSON object (`profileSettingsSchema`) read via
  `profiles.getSettings(project.profile_id)` — the same path the skip-permissions gate uses.

## Design

### 1. Display name — default from the agent, user override separate

Split the two concepts that share `sessions.title` today:

- `sessions.title` → **user override only** (`null` = no override).
- **new** `sessions.agent_title TEXT` (nullable) → the agent's own session name.
- Display name = `title ?? agent_title ?? id.slice(0, 8)`, via a single shared
  `sessionDisplayName(session)` helper (packages/web/src/lib) replacing the ~5 inline
  `title ?? id.slice(0,8)` call-sites (TabStrip, SessionSidebar, SidebarTargetHeader,
  CommandPalette).

**Migration** `010-agent-title.ts`: `ALTER TABLE sessions ADD COLUMN agent_title TEXT`.
**Schema**: add `agent_title: z.string().nullable()` to `sessionSchema` — additive, so bump
`PROTOCOL_VERSION` minor per packages/shared/PROTOCOL.md.

**Adapter**: add optional `sessionTitle(ref, account): string | null` to `AgentAdapter`.
`claude-code` implements it: locate `<ref>.jsonl` (same scan as `hasConversation`), read the
last `agent-name` (`agentName`) else the last `ai-title` (`aiTitle`), normalise (trim, collapse
whitespace, ≤80 chars), null if absent/unreadable. Core stays agent-agnostic. Record the
verified Claude Code version in an adapter comment.

**Freshness**: the daemon refreshes `agent_title` from the **existing** `StatusDetector`
callback path (fires each turn/status change), plus once at spawn and once at exit — no new
watcher subsystem. Each refresh calls `adapter.sessionTitle(ref, account)`; when the value
changes, persist via a new `sessions.setAgentTitle(id, title)` store method and broadcast the
updated session to attached clients (extend the existing rename/session-update broadcast to
carry the full session or the `agent_title` field — exact WS shape decided in the plan; it is a
protocol-additive change).

### 2. Rename fix + empty reverts to default

- Retire the `.puddle/session-title` mechanism: delete `readTitle`, `syncTitle`, `lastTitle`,
  `titleSink`/`setTitleSink` from `MarkerFileSync`; **keep** `syncNotes` (onboarding-notes sync).
  Remove `applyAgentTitle` and its `setTitleSink` wiring in daemon.ts. This removes the race,
  so a UI rename sticks.
- `patchSessionRequestSchema.title` → `z.string().max(200)` (drop `.min(1)`), allowing empty.
  `service.rename(id, title)`: if `title.trim() === ''` → `sessions.setTitle(id, null)` (revert
  to `agent_title`/hex); else store the override. `createSessionRequestSchema.title` unchanged.
- Rename dialog (SessionActions): seed the input from `session.title ?? ''` and show the current
  default (`agent_title ?? id.slice(0,8)`) as the placeholder, so the user sees what clearing reverts to.

### 3. Settings: 'Permissions & Safety' → 'Sessions' + launch templates

- Rename the settings section: label → **Sessions**, id → `sessions`, route `#settings/sessions`
  (SettingsDialog `SECTIONS`). Keep the existing skip-permissions gate in the section.
- Add two editable textareas to the Sessions section, backed by `profileSettings`:
  - **New-worktree launch text** (`onboardingTemplate?: string`): supports a `{{rules}}` token
    where the repo's onboarding notes are injected. Empty allowed.
  - **Existing/shared-worktree launch text** (`concurrentTemplate?: string`). Empty allowed.
  - Semantics: **key absent** → built-in default is used; **empty string** → intentionally
    empty. Each field gets a "Reset to default" affordance that clears the key.
- `profileSettingsSchema` (looseObject): add `onboardingTemplate: z.string().optional()`,
  `concurrentTemplate: z.string().optional()`. No daemon migration (settings JSON is loose).
- `onboarding.ts`: builders take the template string. `buildOnboardingPreamble(template, notes,
  prompt)` — if `template` is provided (including empty) use it and substitute `{{rules}}` with
  the notes (or the "(none recorded yet…)" placeholder); otherwise use the exported
  `DEFAULT_ONBOARDING_TEMPLATE`. Task prompt still appended after `---`. Same shape for the
  concurrent builder. The **default** new-worktree template drops the old step that told the
  agent to write `.puddle/session-title` (that file is gone). `service.ts` passes the templates
  from `profiles.getSettings(project.profile_id)`.

### 4. Right-click context menu

- Refactor `SessionActions` so its action items + confirmation dialogs are shared by two
  triggers: the existing ellipsis `DropdownMenu` and a Radix `ContextMenu` (the primitive
  already exists at components/ui/context-menu.tsx). Likely a hook/config returning the item
  list + the dialog elements, rendered by either menu type.
- Wire right-click to open that menu on: the expanded sidebar row (SessionSidebar),
  the collapsed status dot (CollapsedSessionsRail), and the top tab-strip tabs (TabStrip).
  All show the same kill/resume/rename/archive/move/open-in-editor items.

### 5. Archived sessions — view-only, collapsible

- Archive's cleanup behaviour is unchanged (worktree removal / optional branch delete /
  conversation-store cleanup stay as-is).
- Stop hiding archived sessions: add a **collapsed-by-default "Archived" disclosure** at the
  bottom of the **expanded** sidebar listing them (reuse the `status === 'archived'` split that
  currently excludes them). The collapsed rail continues to omit archived sessions.
- Clicking an archived session opens its tab to read terminal history/scrollback; do not attempt
  `spawnShell`; editor/diffs fall back to the existing `worktree_missing` empty state.
- Ensure the web receives archived rows (verify the sessions list endpoint returns them; the web
  currently filters them client-side — if so, no server change needed, just group instead of drop).

### Non-goals

- No unarchive/restore action (can be added to the shared menu later if wanted).
- No change to what archive destroys.
- Only `claude-code` implements `sessionTitle`; other future adapters may return null.

## Definition of done (docs updated in the same commits)

- `SPEC.md`: §4 (marker files / onboarding templates), §5 (adapter `sessionTitle`), §11/§12
  (Sessions settings tab, right-click, archived disclosure).
- `CLAUDE.md`: adapter interface line if the interface summary is affected.
- `CHANGELOG.md`: Added/Changed/Fixed entries.
- `packages/shared/PROTOCOL.md`: minor bump for `agent_title`.
- Migration `010-agent-title.ts` registered.
- `pnpm test`, `pnpm lint`, `pnpm build` green.
