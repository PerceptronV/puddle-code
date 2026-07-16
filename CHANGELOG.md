<!--
Rolling changelog for the NEXT release. Governance lives in CLAUDE.md §"Changelog discipline".
On publish: retitle [Unreleased] to [X.Y.Z] — date, archive a copy to
docs/changelogs/CHANGELOG-vX.Y.Z.md, then reset this file to this template.
Past releases: see docs/changelogs/.
-->

# Changelog

## [Unreleased]

### Added

- **Unarchive a session** (protocol 6.2, `POST /api/sessions/:id/unarchive`). Archiving is now a **reversible hide**, not a teardown: it keeps the worktree, its branch, and the agent conversation, so archived rows carry the same ⋯ menu and can be brought straight back. If the worktree still exists the session resumes with its history; if it was pruned (or its branch deleted) the session returns visible for its history only, with resume disabled. Archiving itself no longer pops a dialog — one click hides it, and because nothing is destroyed a dirty worktree is safe (SPEC §4).
- **VSCode-style preview tabs** (SPEC §8): single-clicking a file, session, or terminal opens it in one reusable _preview_ tab (shown in italics) that the next single-click replaces; double-clicking the item — or its preview tab — pins it as a permanent tab.
- A third **launch-text template** in Settings → Sessions, "Resume after restart", sent when a session is resumed after a daemon restart or machine reboot (previously a fixed built-in note). Editable per profile; empty sends nothing (protocol 6.2, profile setting `restartTemplate`).
- The **Files** navigator header now names the worktree **directory** (what you're browsing), while Changes and Search keep naming the branch.
- `README.md` gained a **Development & teardown** section: running a local dev build (`--tarball`/`--foreground`) versus the published CLI, killing the cockpit vs. stopping the daemon service (launchd/systemd/nohup), and a full uninstall.
- A per-profile **tab-title template** (Settings → Sessions) composes each session's tab/sidebar label from `${…}` parts — `${name}`, `${branch}`, `${sequence}`, `${status}`, a conditional `${separator}`, and more — with a live preview; the default `${name}` reproduces the previous label. Terminals and agents without their own name now also take a name from the terminal-title escape the process sets (the `${sequence}` value). Protocol 6.0 → 6.1 (additive).

### Changed

- **Top bar** revamp: the puddle mark shrank and now sits beside the daemon's **host name** as one click-home block; the centre is a dimmed command field (hinting the active project name + ⌘K) that opens the palette; the separate ⌘K button is gone.
- The empty workspace pane no longer reserves a blank tab bar; it shows a large, muted puddle mark and a dimmed **⌘K** button that opens the command palette.

### Fixed

- Creating a session or terminal now appears in the sidebar **immediately** instead of only after a reload: the create/rename/archive/kill/migrate mutations invalidated only the per-project session list, never the cross-project sidebar's `['sessions', 'profile', …]` query.
- The **Settings** dialog no longer sometimes changes the URL without opening (needing a reload): programmatic hash writes now notify the `useSyncExternalStore` subscribers directly, closing the gap where assigning the current fragment fires no `hashchange`.
- A session's tab title now tracks a rename made **inside the agent** (e.g. claude-code's `/rename`) live, instead of only after the next status change. Such renames are handled client-side and change no puddle status, so the daemon never re-read the agent's name; it now also re-reads it (throttled) when the agent emits a terminal-title escape sequence (OSC 0/1/2), which claude-code does on rename. The transcript remains the source of truth and a user rename still wins (SPEC §4).
- Filetree header: the branch title now uses the full sidebar width at rest. The utility, pin, and worktree-picker controls surfaced from an overlay on hover/focus instead of reserving (and so occluding) width while hidden — the title was clipped even when no icons showed (SPEC §12).
- Worktrees list: rows now extend to the sidebar's right edge — the hover-only prune control no longer reserves an empty gap after the badges.
- `puddle connect` / `status` no longer fail with "could not open a tunnel" against hosts reached over **Tailscale SSH** (or other non-OpenSSH servers). Over a multiplexed master such servers install the `-L` forward on the master and the spawned `ssh` client exits immediately while the forward keeps carrying traffic; the tunnel wrongly treated that client's exit — and required it to stay alive for readiness — as the tunnel dying. The forward is now judged by the **forward itself**: readiness is its local listener accepting plus an end-to-end probe the daemon answers `/api/version` through, and liveness is a periodic check of that listener — never the spawned client's fate. The `ExitOnForwardFailure=yes` flag (which the same servers trip) was dropped, and forwards abandoned on the master are cleaned up with `ssh -O cancel` since they outlive the client and would otherwise leak the port. Automatic remote-daemon port discovery (runtime.json → config.json → 7434) is unchanged (SPEC §10).
