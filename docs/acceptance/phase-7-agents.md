# Acceptance — Phase 7: codex, opencode and gemini-cli adapters

Manual verification CI cannot do. Everything here needs a **logged-in account**
for the agent under test, which is exactly why it is not a unit test.

Run the daemon from a **plain shell**, never from inside a coding-agent session
— see the `CLAUDECODE` warning in `CLAUDE.md`.

```
pnpm build && pnpm build:tarball
node packages/cli/dist/index.js launch --foreground --tarball dist-release/puddled-v*.tar.gz
```

## 0. What is already verified (do not redo)

Pinned in each adapter's header comment: Claude Code lifecycle payloads
**2.1.238**, codex-cli flags/storage/app-server **0.147.0**, opencode
**1.18.10**, and @google/gemini-cli **0.53.1**. Codex's live idle status was
verified against 0.146.0 and remains a pinned regression. The items below need
real logged-in agents and remain manual even though their storage and lifecycle
parsers have fixtures.

## 1. Status regexes — OpenCode and Gemini CLI remain

Codex, OpenCode, and Gemini still use `statusPatterns` for working/waiting
status even though they now have native lifecycle channels. Wrong regexes leave
sessions stuck on `starting` or permanently `running`.

For OpenCode and Gemini CLI:

1. Create a session and send a prompt that takes a while (e.g. "read every file
   in packages/daemon/src and summarise the architecture").
2. While the agent works, the sidebar must show **running**.
3. When it finishes and waits for input, it must flip to **waiting_input**
   within the quiet-debounce window (~2 s).
4. Send a second prompt: it must go back to **running**.

Codex completed this check on 2026-08-03. Re-run it when upgrading Codex or if
its TUI changes; the table below records the observed 0.146.0 signature.

If a state never appears, capture the real TUI output and correct the adapter's
`statusPatterns`:

```
node packages/daemon/scripts/... # or the scratch pty probe:
# spawn the agent under node-pty, strip ANSI, and read the footer lines verbatim
```

The current patterns and where they came from:

| adapter | waitingInput | busy | source |
| --- | --- | --- | --- |
| codex | `/›[^\r\n]{0,1000}\s·\s/` | `/to interrupt/i` | observed in a live 0.146.0 PTY on 2026-08-03 |
| opencode | `/esc\s+interrupt/i`, `/^\s*>\s*$/m` | `/working/i`, `/thinking/i` | guessed — **most likely to be wrong** |
| gemini-cli | `/Type your message/i`, `/esc\s+to\s+cancel/i` | `/esc\s+to\s+cancel/i` | guessed; the two overlap, which the position-based detector tolerates but which should be tightened once observed |

## 2. Config-dir isolation (SPEC §2 — a hard requirement)

Puddle must never write into a config dir it did not create. Before creating an
account, record the agent's real dir; afterwards it must be **byte-identical**.

```
# codex
ls -la ~/.codex | md5           # before and after
# opencode
ls -la ~/.local/share/opencode ~/.config/opencode | md5
# gemini-cli
ls -la ~/.gemini | md5
```

Then confirm the puddle-owned dir is the one that filled up:

```
find ~/.puddle/profiles/<pid>/accounts/codex/<label>      -maxdepth 2 | head
find ~/.puddle/profiles/<pid>/accounts/opencode/<label>   -maxdepth 3 | head
find ~/.puddle/profiles/<pid>/accounts/gemini-cli/<label> -maxdepth 3 | head
```

Expect `sessions/` under the codex account, `data/opencode/auth.json` under the
opencode account, and `.gemini/` under the gemini account.

**opencode specifically:** run `opencode debug paths` with the account's env and
confirm every path points inside the puddle account dir.

## 3. Resume, per adapter

- **codex** — start a session, let it write a rollout, interrupt it, resume from
  the UI. History must come back. Confirm the API's `agent_session_ref` (joined
  from `agent_conversations`) is the rollout UUID and **not** the Puddle session
  id. If the ref *is* the Puddle id, `resolveSessionRef`'s
  10 s poll expired: check that the rollout appeared and widen it if needed.
  Also inspect `state_<n>.sqlite`: its top-level `threads` row should normally
  let puddle capture the ref before the rollout's first JSONL line is readable.
  Then create two Codex sessions concurrently in the same shared worktree and
  account: their refs must be distinct, and neither may be a rollout whose
  `session_meta.payload.parent_thread_id` is set. Restart the daemon and confirm
  each session restores its own history. Codex's `/resume` picker is its own
  cwd-filtered/index-backed UI; puddle restart resume is the explicit UUID path.
- **codex bypass-on-resume (openai/codex#9144)** — create a session with skip
  permissions on, resume it, then ask it to run a shell command. If it prompts
  for approval, the flag is accepted but not honoured on resume: record that in
  the adapter header and surface it in the UI rather than silently misleading
  the user.
- **opencode** — same interrupt/resume and concurrent shared-worktree cycle.
  Confirm both refs are distinct and `ses_`-prefixed, and that creation-time
  `discoverSessionRef` finds each one (the on-disk store layout under a
  redirected `XDG_DATA_HOME` is the part inferred rather than observed).
- **gemini-cli — the known open risk.** `--resume` is documented as taking
  `latest` or an *index*, but the adapter presets a UUID via `--session-id` and
  resumes by that UUID. Verify `gemini --resume <uuid>` actually restores the
  conversation. If it only accepts an index, change `resumeArgs` to map the ref
  to an index via `--list-sessions`, or set `capabilities.resume: false` and let
  the documented degradation path take over.

## 4. Missing-binary detection

With an agent's CLI absent from PATH (rename it, or just test an agent you have
not installed):

1. Settings → Accounts shows that agent's block with "Not installed — no
   `<binary>` on the daemon's PATH", and its **Add account** button is disabled.
2. Any existing account of that agent has a disabled **Login** button.
3. The profile panel shows the agent's group labelled "not installed" and its
   rows read `unavailable`, with no clickable sign-in.
4. `curl` the API directly to confirm the daemon refuses rather than relying on
   UI gating alone:
   ```
   curl -X POST -H "authorization: Bearer $TOKEN" localhost:7434/api/accounts/<id>/login
   # → 424 {"error":{"code":"agent_not_installed", ...}}
   ```
5. **The regression that motivated this:** the account's `logged_in` badge must
   be unchanged afterwards. Before the fix, a rejected create wrote
   `logged_in = false` and downgraded an authenticated account.
6. Install the CLI (or restore it to PATH) and, **without restarting the
   daemon**, wait ~30 s or refocus the tab: the controls must re-enable.

## 5. Tier-2 cross-agent hand-off (SPEC §14 acceptance test)

> hand off a claude session to codex — new session in the same worktree opens
> with the transcript summary as its first prompt

1. Run a claude-code session far enough to have real history (a few turns and
   at least one commit on its branch).
2. Session menu → **Continue on…** → pick a **codex** account under "Hand off to".
3. Confirm the lossy-hand-off warning, then check:
   - a **new** session appears, in the **same worktree path and branch**;
   - its first prompt contains the conversation summary, the `git log
     --oneline base..HEAD` output, and `git status --short`;
   - the previous agent's thinking blocks are **absent** (degraded by design);
   - the **original session is untouched** — same status, not killed;
   - both sessions carry linking events (`handed_off_to` / `handed_off_from`).
4. Repeat in the other direction (codex → claude-code) to exercise codex's
   `exportTranscript`.
5. Hand off **from** an opencode or gemini-cli session — neither implements
   `exportTranscript` for gemini, so this exercises the PTY-log-tail fallback.
   The prompt must still be non-empty and readable.

## 6. Native conversation switching and catalogue sync

Run each case in a project that shares a registered repository/worktree with a
second project. Keep two browser windows open for the multi-viewer checks.

1. Start one top-level conversation for each agent and verify its placement
   reports `native_sync: full`. For an unsupported CLI version or deliberately
   failed lifecycle bridge, verify the agent still starts directly, reports
   `fallback`, and shows one restrained warning; catalogue discovery must still
   work, but in-agent switches must not move the tab.
2. Exercise `/clear`, `/resume`, and `/fork` inside the agent. The old placement
   must freeze as `exited`; the target must become live and unarchived in the
   same project/worktree; `/fork` must expose the source conversation as parent.
   Shell tabs, exported environment, and detected app ports must follow. The
   target keeps its own Puddle title overlay and receives branch ownership.
3. Exercise `/compact`. It must not create or focus another placement. Repeat
   with Codex review/side threads, an OpenCode child session, and an agent
   subagent: none may switch the top-level placement.
4. Archive the currently live placement. Its runtime must stop and only that
   placement becomes archived. Resume it natively from another live placement:
   explicit native intent must unarchive and focus it. A background catalogue
   scan alone must never unarchive it.
5. Open conversation B while it already has a live Puddle runtime, then make
   runtime A resume B. A must stop as an expected exit and remain visible;
   viewers focused on A must focus B. Put B in the other project and confirm the
   viewer navigates there, using that project's saved layout and opening B as a
   preview only when absent. A second window not focused on A updates its lists
   without following.
6. Create two simultaneous native switches and two REST resumes of the same
   conversation. Exactly one runtime may remain. A REST loser must receive
   `409 conversation_live` with the existing session/project details, and the
   cockpit must use those details to focus the owner.
7. Rename an inactive native conversation. Project activation or a watched
   store event must update its native title without changing its Puddle title.
   Delete its native data: only two successful scans may show “conversation
   missing”, and resume must be disabled. Recreate it and verify the badge
   disappears. A permission/read failure must never mark it missing.
8. Archive the second project and create another native conversation. No
   placement may appear there or in another profile. Unarchive the project and
   enter it: activation refresh should materialise the exited placement without
   waiting for a browser polling interval.
9. Restart the daemon from a plain shell with auto-resume on. Reconciliation
   must preserve one runtime owner per conversation and restore the correct
   placement, terminal segment, environment, and sidecar process roots.
