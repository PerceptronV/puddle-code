# Phase 3 acceptance — files, diff, history (manual, real browser)

SPEC §14 Phase 3 acceptance, run by hand against the built daemon with a real
git repo and a real logged-in claude-code account. The pure logic (tab-order
reducers, draft sequencing, diff/history status helpers, panel-layout
filtering, the model refcounter) is unit-tested in CI; everything Monaco
touches — mounting, disposing, binding to the shared buffer store — cannot
run under vitest (Monaco needs a real `window`) and was flagged as an
outstanding gap in every Phase 3 implementation report. This script is where
that gap closes.

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

Create a profile, a project against a real git repo with some history (a repo
with >50 commits is needed for item 4's pagination check), and add + login a
real claude-code account. Start a session so there's a live worktree to point
the explorer, diff, and history views at.

1. **Explorer & editor.** The tree shows the worktree's files (directories
   first, then files, both alphabetical; dotfiles present but visually muted).
   Open a file, edit it, ⌘S: the save is silent (no dialog on the happy path),
   and the agent's next `cat` of the file in the session terminal shows the
   change (AT — SPEC §14). On the very first editor open in a fresh browser
   tab, open DevTools → Network before clicking the file and confirm zero
   requests to `cdn.jsdelivr.net` or `unpkg.com` (Monaco is fully
   self-hosted), and Console shows no errors. **Conflict drill**: with the tab
   still open, have the agent edit the same file on disk, then ⌘S the stale
   tab → a toast offers **Reload** (discards your edit, adopts disk) and
   **Overwrite** (writes through unconditionally); both work and leave the tab
   clean afterwards.
2. **Diff.** Have the agent modify one file and add a new one, then open the
   session's Diff tab: the list shows each file's name-status (added/
   modified/deleted/renamed) and the header's counts match. Hand-edit the
   modified file's right-hand (working) side inside the diff and ⌘S — the
   agent's next `cat` shows it (AT), and if that same file is also open as an
   editor tab, the tab reflects the edit immediately (shared buffer) and
   keeps working after the diff section is collapsed or the Diff tab is left
   (refcounted model, no premature disposal — watch the console for a Monaco
   `BugIndicatingError` on any of these transitions). A newly added file
   renders as a plain editor, not a diff. Collapse a **modified** section
   whose file has **no** open editor tab, then re-expand it: the console
   stays clean and the content reloads fresh. Long file paths in a section
   header truncate with an ellipsis rather than overflowing the row (a known
   regression risk — Task 8's header did not get the same truncation fix
   later applied to the history view's).
3. **History.** The commit list matches `git log --oneline -n 20` sha-for-sha,
   newest first (AT). Selecting a commit shows its own message and per-file
   diffs: a modified file's two sides match `git show <sha>^:<path>` and
   `git show <sha>:<path>`; a renamed file's left side resolves via its old
   path; an added file shows a plain read-only viewer (no diff gutter); a
   deleted file shows a "Deleted" note plus its last content. The initial
   (root) commit's files all render as `added` with no console error from a
   `sha^` fetch against a parent that doesn't exist. On a repo with more than
   50 commits, **Show more** pages deeper, showing "Loading…" mid-fetch and
   disappearing once the last page loads. Select an older commit, expand a
   file, then select a different commit that touches the *same* path — the
   detail pane shows the new commit's own content (not stale/reused), the
   section's expand state resets to default, and no Monaco disposal warnings
   appear (a previously-fixed model-leak regression: watch for it recurring).
   Click-to-copy a commit sha shows a toast and the clipboard holds the full
   40-character sha, not the truncated 7-character display.
4. **Transfer.** Drag a file from the desktop onto a folder in the explorer:
   it appears in the worktree and in the agent's `ls` (AT). Drag a *folder*
   onto the explorer instead: a toast says folders can't be uploaded yet and
   says to zip them first (any plain files in the same drop still upload).
   Download that folder via the context menu: the zip's contents match the
   folder and contain no `.git` directory (AT). Download a single file: the
   bytes are byte-identical to the worktree copy, not zipped. Pasting copied
   files (⌘V, not drag) into the explorer uploads them the same way a drop
   does.
5. **Pin & layout.** Pin the explorer to session A's worktree from Settings →
   pin control, switch the active tab to session B: the tree stays on A's
   files. Resize the sidebar and the editor/terminal split, reload the page:
   both sizes restore exactly. Close the explorer and the editor pane, then
   reopen both: the panel ratios come back sane (some drift when toggling a
   conditional panel is an accepted, cosmetic limitation — note it if seen,
   it isn't a regression to chase).
6. **Multi-window drill.** Open the same project in two browser windows: each
   window's session/editor tabs and pane layout are independent, and
   reloading either window restores only that window's own state. Close one
   window, then open a brand-new window on the same project: it seeds from
   the server snapshot (the last window to write, not necessarily the one you
   just closed). Save a file in window 1 while it's clean in window 2: window
   2 refreshes silently, no badge. Make the same file dirty in both windows:
   both show a "being edited elsewhere" badge. ⌘S the stale one afterwards
   follows the normal 409 Reload/Overwrite path from item 1.
7. **Drafts.** Edit a file without saving, then kill the browser process
   entirely (not just the tab) and reopen the project: the editor shows
   "Restored unsaved changes" with the dirty buffer intact; **Discard** clears
   it back to the saved content. Create a draft, then have the agent change
   the same file on disk before you reopen the browser: instead of silently
   restoring, a "Restore draft" toast offers the choice explicitly.
8. **Theme.** Switch dark/light (⌘K or Settings → Appearance): chrome,
   terminals, and every open Monaco instance (editor tabs and any open
   diff/history view) restyle together with no reload. `pnpm --filter
   @puddle/web check-tokens` passes.

Record any UI/daemon mismatches found here as issues; adapter corrections
still go to `packages/daemon/src/agents/claude-code.ts` per phase-1.
