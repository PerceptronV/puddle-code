# Tier-1 migration acceptance — shared conversation store + Move-to-account (manual, real agent)

SPEC §14 (tier-1 migration ships ahead of Phase 7) and §5 (the shared
conversation store, Workstream S). Run by hand against the built daemon with a
real git repo and **two real, logged-in claude-code accounts on one profile** —
the whole point is to prove that a conversation adopted under account A resumes
under account B with B's own credentials, which CI cannot do (it has no second
set of real Anthropic credentials and injects the plain `fakeAdapter`, whose
`conversationShare` hooks are inert). The store mechanics (adopt / mirror /
backfill / reconcile / archive) are unit-tested in `test/conversation-share.test.ts`
and the migrate endpoint's fall-through/validation matrix in `test/e2e.test.ts`
(`fakeAdapter({ share: true })`); everything below needs real `claude --resume`.

Setup:

```sh
pnpm build
export PUDDLE_HOME=$(mktemp -d)
node packages/daemon/dist/index.js &
until [ -f "$PUDDLE_HOME/token" ]; do sleep 0.2; done   # the daemon writes it on boot
open "http://127.0.0.1:7433/#token=$(cat $PUDDLE_HOME/token)"
```

**Start the daemon from a plain shell, not from inside this (or any) coding-agent
session** — see CLAUDE.md's warning: `puddled` inherits `CLAUDECODE`/`CLAUDE_CODE_*`
and a `claude` it spawns with those set writes no resumable transcript, so
`--resume` silently fails ("no conversation found") and every step below would
lie. Verify with `ps eww <daemon-pid> | tr ' ' '\n' | grep CLAUDE` — nothing.

Create a profile `P`, register a real git repo, create a project on `P`, then add
**two** claude-code accounts `A` and `B` and log **both** in (Settings → Accounts
→ each account → Log in, complete the browser flow). Both must show the
logged-in dot.

Let `<pid>` be the profile id and `<key>` the store-key (the escaped main-repo
root) throughout.

1. **Adopt under A.** Start a session on account `A` with a short, memorable
   first prompt — e.g. *"Remember the codeword FERN. What is 2+2?"* Let the agent
   answer and settle to waiting-input. Confirm on disk:
   - `~/.puddle/profiles/<pid>/sessions/claude-code/<key>/<uuid>.jsonl` exists
     (the canonical conversation, `<uuid>` = the session's `agent_session_ref`).
   - **Both** accounts hold a symlink at
     `<A config_dir>/projects/<key>` and `<B config_dir>/projects/<key>` →
     the canonical dir (`ls -l` shows the arrow; `readlink` resolves it).
2. **Worktree store-key stability** (Task 17 report item 2). Start a *second*
   session on the same repo (a different branch/worktree). Confirm its
   conversation lands in the **same** `<key>` dir — one canonical dir spans a
   repo's worktrees because claude escapes the *main* repo root, not the
   worktree path. (Two `<uuid>.jsonl` files now sit under `<key>/`.)
3. **Kill and migrate via the UI.** Kill the step-1 session from the sidebar
   menu (it usually would have exited on its own from credit exhaustion; killing
   simulates that). Open its menu → **Move to account…** → **B**. The submenu
   lists only same-agent accounts of `P`; `A` appears **disabled** with a
   *current* hint; had `B` been the only other account and it been removed, the
   whole submenu would be hidden. Confirm the dialog ("Move this session to B?
   The conversation continues under that account's credentials.") → **Move
   session**. A success toast appears; the session's account label in the
   sidebar flips to `B` and it returns to running/waiting-input.
4. **The agent recalls the earlier conversation (the SPEC §14 tier-1 AT).** In
   the now-resumed session (running under B's credentials), ask
   *"What did I ask you first, and what was the codeword?"* The agent answers
   from history — the first question and **FERN** — proving `--resume` under B
   read the conversation through B's mirror symlink, with **no file moved**.
   Re-confirm the canonical `<uuid>.jsonl` is still at the same path.
5. **skip_permissions re-evaluation across the move (§11.4).** Open the profile
   gate (Settings → Permissions) and opt both `A` and `B` in, then start a fresh
   skip-permissions session on `A`. Kill it. **Close the gate** (or revoke B's
   opt-in). Move it to `B`. It resumes **without** the skip flag and the terminal
   prints *"skip-permissions no longer permitted; continuing with prompts on."* —
   never a hard failure.
6. **Todos degradation matches the pinned note** (§5 ancillary caveat). If the
   step-1 conversation had produced a todo list, note that `<A>/todos/<uuid>*.json`
   does **not** travel to `B` — the migrated session resumes its full transcript
   but starts with no todo list (the agent rebuilds it). This matches
   `claude-share.ts`'s pinned finding (per-account ancillary state does not move).
7. **Archive removes only that session's file** (Task 17 report item 3). With
   two sessions still sharing `<key>` (from step 2), archive **one**: its
   `<uuid>.jsonl` disappears from the canonical dir but the dir and both symlinks
   survive (the other session still lives there). Archive the **second**: the
   canonical `<key>` dir **and** every account's symlink to it are gone.
8. **Backfill folds in an imported dir** (Task 17 report item 4). Create a third
   account `C` on `P` by **importing** a real config dir that already holds a
   `projects/<key>` for a key the profile has adopted. Confirm the import
   *merged* the real dir into the canonical store (no `<uuid>.jsonl` lost) and
   left `C` holding a symlink — a session can then migrate to `C` and resume.
9. **Deleting account A leaves the conversation resumable under B** (Task 17
   report item 5). Delete account `A` (Settings → Accounts → Delete). The
   canonical store is untouched (removing A's config dir unlinks A's symlink
   without following it). The step-4 session — now on `B` — still resumes with
   full history.

Record any UI/daemon mismatch as an issue; adapter corrections (store-key
escaping, todos glob, resume flags) go to `packages/daemon/src/agents/claude-*.ts`
with the verified claude version pinned in a comment, per phase-1.
