# Phase 4 acceptance — terminal links, open-in-editor (manual, real browser)

SPEC §14 Phase 4 acceptance, run by hand against the built daemon with a real
git repo and a real logged-in claude-code account. The pure logic (path-
candidate regex, the resolve-validation cache, wrapped-line assembly,
`editorDeepLink`, host precedence, `?host=` parsing) is unit-tested in CI;
everything that needs a live xterm instance, a real hover/click, or an actual
`vscode://`/`cursor://` handler on the machine cannot run under vitest. This
script is where that gap closes.

Setup:

```sh
pnpm build
export PUDDLE_HOME=$(mktemp -d)
node packages/daemon/dist/index.js &
until [ -f "$PUDDLE_HOME/token" ]; do sleep 0.2; done   # the daemon writes it on boot
open "http://127.0.0.1:7433/#token=$(cat $PUDDLE_HOME/token)"
```

**Start the daemon from a plain shell, not from inside this (or any) coding-agent
session.** `puddled` inherits `CLAUDECODE`/`CLAUDE_CODE_*` from its parent
process and passes them to every agent it spawns (`PtyManager` uses
`{...process.env}` by design); a `claude` that sees those vars treats itself
as a nested child and does not write a resumable conversation transcript, so
sessions in this script would silently fail to resume (see CLAUDE.md). If a
session won't resume, check the daemon's env first
(`ps eww <pid> | tr ' ' '\n' | grep CLAUDE`).

Create a profile, a project against a real git repo, and add + log in a real
claude-code account. Start a session so there's a live worktree and terminal
to test against. VS Code and/or Cursor should be installed locally (with
their CLI-registered URL scheme handlers — the normal state after a regular
install on macOS) so the open-in-editor links have somewhere to land.

1. **Terminal link surface.** Ask the agent to print, in one message: a real
   file path with a line and column (`src/<file>:<line>:<col>` — pick a file
   that actually exists in the worktree), a path to a file that does not
   exist (e.g. `nope.ts`), prose that merely looks path-shaped (`e.g.` or
   `3.14`), and a plain URL (`https://example.com`).
2. **URL links.** Hovering the printed URL underlines it. Both a plain click
   and a cmd/ctrl+click on it open it in a new browser tab (both gestures —
   the web-links handler covers both).
3. **File-path validation.** Hovering the real `src/<file>:<line>:<col>` path
   underlines it only once `/resolve` confirms it exists (briefly
   un-underlined the instant it's printed, then underlined) — hovering the
   nonexistent path or the path-shaped prose never underlines, no matter how
   long you hover.
4. **Open at line/column (AT — SPEC §14).** cmd/ctrl+click the real path:
   a Monaco tab opens at that exact line and column. A **plain** click on
   the same path does not open the editor — terminal text selection still
   works normally.
5. **Wrapped long path.** Narrow the terminal (resize the window or the
   sidebar) until a long real path soft-wraps across two rows: hovering
   still underlines the whole logical path spanning both rows, and cmd/ctrl+
   click still opens it at the right line.
6. **Login terminal.** Open a login terminal for an account (Settings →
   Accounts → an account's login flow). A URL printed there still underlines
   and opens on click; a file path printed there does NOT underline on hover
   (a login PTY has no worktree to resolve against).
7. **Hover flood.** Print a screen full of plausible-looking paths (a `find`
   of the repo works) and hover across all of them in quick succession: the
   UI stays responsive and the daemon doesn't stall (concurrency cap +
   caching on `/resolve`).
8. **Open in VS Code — local.** From the session's `⋯` menu, click
   **Open in VS Code**: the OS hands off to VS Code, which opens the exact
   worktree directory (`vscode://file/<worktree_path>`, no ssh-remote form,
   since no SSH host is configured). Repeat for **Open in Cursor**
   (`cursor://file/<worktree_path>`).
9. **Open in editor — SSH form + host precedence.** In Settings → Terminal &
   editor, set "SSH host for editor links" to `alice@devbox` (any placeholder
   host — nothing needs to actually resolve for this check, you're only
   confirming the emitted URI). Click **Open in VS Code** again: the OS
   receives `vscode://vscode-remote/ssh-remote+alice@devbox/<worktree_path>`
   this time (check via the OS's "open with" prompt, or watch what VS Code
   tries to connect to). Clear the setting, add `?host=alice@devbox` to the
   browser's address bar, and reload: the param disappears from the address
   bar immediately (captured, not left dangling in history) and the next
   **Open in VS Code** click uses the same ssh-remote form — the stored
   `?host=` value substitutes for the now-empty client setting.
10. **Missing worktree.** Archive or otherwise put a session into a
    `worktree_missing` state (or simulate by removing the worktree directory
    on disk and reloading): the session menu no longer shows **Open in VS
    Code** / **Open in Cursor** at all.

Record any UI/daemon mismatches found here as issues; adapter corrections
still go to `packages/daemon/src/agents/claude-code.ts` per phase-1.
