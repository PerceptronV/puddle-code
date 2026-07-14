# Usage via `claude -p /usage` + profile panel as a top-right popover

Date: 2026-07-14 · Status: approved

## Problem

The profile panel's subscription rate-limit bars were built on an undocumented
OAuth usage endpoint: puddle read the account's own token from
`.credentials.json` and called the API directly. That required a per-account
opt-in (`accounts.rate_limit_tracking`, migration 005), a credential carve-out
in SPEC §2, and it never worked on macOS (keychain-bound tokens). The endpoint
itself was never verified against a live response.

Separately, the profile panel opens as a centred dialog, though it is invoked
from — and belongs to — the profile button in the top-right of the top bar.

## Decision 1 — fetch usage with `claude -p /usage`

Claude Code's print mode answers `/usage` with plain, parseable text (verified
against 2.1.209):

```
Current session: 43% used · resets Jul 14 at 6:49am (America/Los_Angeles)
Current week (all models): 28% used · resets Jul 20 at 3:59am (America/Los_Angeles)
Current week (Fable): 47% used · resets Jul 20 at 3:59am (America/Los_Angeles)
```

- New daemon module `claude-usage-cli.ts` spawns `claude -p /usage` via
  `execFile` with the account's `CLAUDE_CONFIG_DIR`, a 30 s timeout, and
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` scrubbed from the env —
  verified empirically that an API key takes auth precedence and silently
  suppresses the subscription windows. `CLAUDECODE` / `CLAUDE_CODE_*` are
  scrubbed too so a development daemon accidentally started inside an agent
  session still reads clean output.
- Lines matching `Current <label>: N% used · resets <text>` become windows;
  labels are taken from the output, not hardcoded, so new windows (e.g.
  "week (Fable)") appear without code changes. Any failure — non-zero exit,
  timeout, no matching lines — yields `null`, never a wrong figure.
- Per-account in-memory cache: successes ~5 min, failures ~1 min (each fetch
  spawns a process). Fetched only for logged-in accounts, awaited inline by
  `GET /api/accounts/:id/usage`.
- `claude-subscription.ts` (OAuth) is deleted. SPEC §2's credential carve-out
  paragraph goes with it: puddle is back to "never reads credentials", no
  exceptions.
- The opt-in dies: migration 006 drops `accounts.rate_limit_tracking`; the
  PATCH field, store method, and the panel's "track subscription usage"
  switch are removed. Bars simply appear when data exists; unavailability
  shows nothing (the bars are supplementary).
- Wire shape: `subscription.windows[].resets_at` (ISO) becomes `resets` —
  the CLI's own reset text with the timezone parenthetical stripped
  ("Jul 20 at 4am"), displayed verbatim. Field removals + rename are
  breaking → PROTOCOL_VERSION major bump.

Rejected alternatives: keeping the OAuth path (unverified, macOS-broken,
needs the carve-out); scraping `/usage` from live session PTYs (fragile ANSI
parsing, only works while a session runs).

## Decision 2 — profile panel anchors under its button

`ProfilePanel` converts from a centred `Dialog` to a Radix popover anchored
under the profile button (right-aligned, small offset). New owned primitive
`components/ui/popover.tsx`, styled per HUMANS.md: elevated surface, no
border. The ⌘K palette, settings dialog, and login dialog stay centred.

## Untouched

The status-line context bar (`claude-statusline.ts`) and JSONL token totals
(`usageStats`) are credential-free and independent — no changes.
