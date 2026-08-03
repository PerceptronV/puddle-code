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

Pinned in each adapter's header comment from a scratch install on 2026-07-31:
codex-cli **0.146.0**, opencode **1.18.10**, @google/gemini-cli **0.53.1**.
Flags, subcommands, config-dir isolation variables, and codex's rollout format
were all checked against those versions. The items below are the ones that
`--help` and an unauthenticated run genuinely cannot answer.

## 1. Status regexes (all three) — the highest-value check

None of these adapters has a hook side-channel, so `statusPatterns` is the
**only** thing driving session status. Wrong regexes leave sessions stuck on
`starting` or permanently `running`.

For each of codex, opencode and gemini-cli:

1. Create a session and send a prompt that takes a while (e.g. "read every file
   in packages/daemon/src and summarise the architecture").
2. While the agent works, the sidebar must show **running**.
3. When it finishes and waits for input, it must flip to **waiting_input**
   within the quiet-debounce window (~2 s).
4. Send a second prompt: it must go back to **running**.

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
  the UI. History must come back. Confirm `sessions.agent_session_ref` is the
  rollout UUID and **not** the puddle session id (this adapter is the first
  where the two differ). If the ref *is* the puddle id, `resolveSessionRef`'s
  3 s poll expired: check that the rollout appeared and widen it if needed.
- **codex bypass-on-resume (openai/codex#9144)** — create a session with skip
  permissions on, resume it, then ask it to run a shell command. If it prompts
  for approval, the flag is accepted but not honoured on resume: record that in
  the adapter header and surface it in the UI rather than silently misleading
  the user.
- **opencode** — same interrupt/resume cycle. Confirm the ref is `ses_`-prefixed
  and that `discoverSessionRef` finds it (the on-disk store layout under a
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
