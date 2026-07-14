# Puddle Phases 3–5 + shared conversation store — files/diff/history, terminal links, ports, tier-1 migration

## Context

Phases 0–2 are complete (daemon core, security layer, claude-code adapter, UI shell with themes/settings/persistence). This plan covers SPEC §14 Phases 3–5, plus one user-requested workstream pulled forward from Phase 7 (Workstream S below — symlink-shared Claude conversation stores and tier-1 migration):

- **Phase 3 — files, diff, history**: file explorer, Monaco editing, diff tab (editable modified side), history tab, drag-in upload / context-menu download (zipped folders). Eight new `/api/worktrees/:sid/*` endpoints.
- **Phase 4 — terminal links**: URL links via `@xterm/addon-web-links`, a custom file-path link provider validated by a new `/resolve` endpoint, cmd+click → Monaco at line, open-in-editor deep links.
- **Phase 5 — ports**: per-session listening-port detection, ports UI (localhost link / copy `ssh -L` / open via proxy), tier-2 reverse proxy `/proxy/:sid/:port/*` with WebSocket upgrade (Vite HMR works through it).
- **Workstream S — shared Claude conversation store + tier-1 migration** (user fold-in, confirmed by choice): instead of moving session JSONLs between accounts, share each conversation project dir across all of a profile's Claude accounts via symlinks to a canonical store under `~/.puddle/profiles/<profile_id>/sessions/claude-code/`; migration then reduces to stop → repoint `sessions.account_id` → resume under the target's `CLAUDE_CONFIG_DIR`. Includes the `POST /api/sessions/:id/migrate` endpoint and a minimal "Move to account…" UI action (both confirmed in-scope); JSONL-copy `migrateSession` stays only as the fallback for agents whose stores can't be shared. **Confirmed granularity decision**: the canonical unit is the *observed* project dir Claude Code creates (the adapter's pinned 2.1.208 finding says worktree cwds escape from the main repo root, so one dir may span a repo's worktrees) — archive deletes only that session's own files and removes the dir when empty, so other sessions' conversations are never mixed in or deleted, whichever way the installed version keys dirs.

**User-added requirements (confirmed by choice):**
1. **First-class multi-window editing — conflict-safe independent buffers.** Each window edits its own buffer; drafts share IndexedDB; windows coordinate via BroadcastChannel (clean views auto-refresh on another window's save; dual-dirty shows a warning badge); saves guarded by an mtime check.
2. **Per-window working set.** Each window keeps its own tabs/active session/splits/explorer pin in sessionStorage — reloading a window restores exactly that window; fresh windows seed from the server snapshot, which the most-recent window keeps updated (cross-machine seed unchanged). This **amends SPEC §11's last-writer-wins wording** — update SPEC in the same commit.
3. **Unsaved changes persist in browser cache**: dirty editor buffers are written to IndexedDB (debounced ~1 s) and restored on reload.

**Concurrency caution**: another agent session has uncommitted changes in `packages/shared/src/protocol.ts`, `packages/web/src/lib/queries.ts`, `packages/web/src/features/shell/ShellLayout.tsx`, accounts files, `packages/daemon/test/e2e.test.ts`. All edits to those files must be additive; **re-read them at execution time**; take "next free protocol minor", not a hard-coded number; never stash/reset (see memory: concurrent-agents-in-checkout).

**Housekeeping per CLAUDE.md (every commit)**: SPEC.md updated in the same commit as any behaviour change; CHANGELOG.md `[Unreleased]` entry per user-visible change; protocol bump in the same commit as schema additions (all Phase 3–5 additions are minor bumps — currently 4.0); British English; TS strict; split files nearing ~300 lines.

---

## Phase 3 — files, diff, history

### 3.1 Shared schemas (`packages/shared`) — one commit with a minor protocol bump

Template: `src/api/worktrees.ts` (paste shapes). Re-export new files from `src/index.ts` with `.js` extensions. snake_case wire fields; primitives from `src/api/common.ts`.

**New `src/api/worktree-files.ts`**: `treeEntrySchema` `{name, type: 'file'|'dir'|'symlink', size: number|null}`; `treeResponseSchema` `{path, entries[]}`; `fileResponseSchema` `{path, content: string|null, binary, size, mtime_ms}`; `putFileRequestSchema` `{content, expected_mtime_ms?}`; `putFileResponseSchema` `{path, mtime_ms, size}`; `uploadResponseSchema` `{files: {path, size}[]}`.

**New `src/api/worktree-git.ts`**: `diffStatusSchema` enum `added|modified|deleted|renamed`; `diffEntrySchema` `{path, status, old_path: string|null}`; `diffResponseSchema` `{against /* resolved sha */, base_ref: string|null, entries[]}`; `fileAtResponseSchema` `{path, ref, content: string|null, binary}`; `commitSummarySchema` `{sha, subject, author_name, author_email, authored_at}`; `logResponseSchema` `{commits[], has_more}`; `showCommitResponseSchema` `{commit: …+body, parents[], files: diffEntry[]}`.

**Edit `src/api/sessions.ts`**: optional `git_summary: {ahead, behind, dirty_files} | null` on the session schema (decision: implement now — closes existing SPEC §6 ↔ code drift; computed only on single-session GET, never on lists).

**Edit `src/api/project-state.ts`** (additive keys on the looseObject): `active_editor_tab: {session, path} | null`, `explorer_open: boolean` (defaults). `editor_tabs`/`explorer_pin` already exist.

### 3.2 Daemon — file endpoints

**New `src/http/routes/worktree-shared.ts`**: `resolveWorktree(sessions, c)` (404 via store; `existsSync` guard → 409 `worktree_missing` — paste's pattern) and `containedPath(root, rel)` (mirror `src/http/static.ts`: normalize+join, prefix check, plus `realpathSync` re-check against symlink escape → 400 `path_outside_worktree`).

**New `src/http/routes/worktree-files.ts`** — `worktreeFileRoutes({sessions})`:
- `GET /:sid/tree?path=` — **one level per request** (explorer lazy-loads; recursive dumps are unbounded with node_modules). `readdirSync(withFileTypes)`, filter `.git`, dirs-first case-insensitive sort, lstat for symlinks. 400 `not_a_directory`.
- `GET /:sid/file?path=` — 404; 400 `not_a_file` for dirs; 413 `file_too_large` > 5 MiB; NUL-heuristic (first 8 KiB) → `{binary: true, content: null}` (UI shows "Binary — use Download"); else content + `mtime_ms`.
- `PUT /:sid/file?path=` — optimistic concurrency: `expected_mtime_ms` present and ≠ current stat → 409 `stale_file` (message carries current mtime); absent → unconditional write (the "Overwrite anyway" path). Parent dir must exist. Returns fresh stat.
- `POST /:sid/upload?dir=` — reject `content-length` > 100 MiB (413 `upload_too_large`) before `c.req.parseBody({all: true})`; filenames → `basename()` + containment; **overwrite silently** (drag-in replaces, like OS copy); 400 `nothing_uploaded`; 201.
- `GET /:sid/download?path=` — file: stream with `content-disposition: attachment` (RFC 5987 filename). Directory: **`yazl`** zip stream (pure JS, streaming, MIT — fits the no-native-deps tarball policy; `archiver` is heavy, `zip`/`git archive` unavailable/wrong). Skip `.git` and symlinks only (node_modules downloads if explicitly asked). Add `yazl` dep (+ `@types/yazl`; `yauzl` as devDep for round-trip tests).

**Edit `src/http/routes/worktrees.ts`** → thin aggregator: keeps `POST /:sid/paste`, mounts `worktreeFileRoutes` + `worktreeGitRoutes` (keeps every file under the ~300-line seam). No `app.ts` change needed (deps stay `{sessions}` — git runs in the worktree, no repo lookup).

### 3.3 Daemon — git read endpoints + session git summary

**Edit `src/git/exec.ts`**: add `gitBuffer(args, opts): Promise<Buffer>` (`encoding:'buffer'`, no trim — `git()`'s trim corrupts blobs/trailing newlines). Additive.

**New `src/worktrees/inspect.ts`** — read-only helpers, **no KeyedMutex** (precedent: `GET /api/repos/:id/branches`):
- `resolveBaseSha(worktree, baseBranch)` — `origin/<base>` when `rev-parse --verify` says it exists, else local; then **`merge-base <ref> HEAD`** (diff shows what the session changed, not upstream drift). Response echoes the resolved sha so `file-at` and the list can never disagree.
- `diffNameStatus(worktree, sha)` — `git diff --name-status -z -M <sha>` (NUL-parsed; `R*`→renamed+old_path, `T`/`C`→modified) + `git ls-files --others --exclude-standard -z` appended as `added` (honours `.puddle/` exclusion for free).
- `blobAt`, `logPage` (`--format` with `%x1f`/`%x1e` separators, `limit+1` → `has_more`, limit clamp 1–200 default 50), `showCommit` (`--root` for the initial commit), `gitSummary` (`rev-list --left-right --count <base>...HEAD` + `status --porcelain` line count; git failure → null).
- `assertSafeRef` (reject leading `-`; argv-injection guard) → 400 `invalid_ref`; `assertSha`.

**New `src/http/routes/worktree-git.ts`**: `GET /:sid/diff?against=base|<sha>` (default base; 400 `invalid_against`, 404 `unknown_ref`), `GET /:sid/file-at?ref=&path=` (404 `not_at_ref` — the UI's "new file → plain editor" signal), `GET /:sid/log?limit=&skip=` (400 `invalid_pagination`), `GET /:sid/show/:sha`.

**Edit `src/http/routes/sessions.ts`**: single-session GET gains `git_summary` via `inspect.gitSummary`.

**Tests**: new `test/worktree-files-routes.test.ts` and `test/worktree-git-routes.test.ts` following `test/worktree-routes.test.ts` (bare Hono + `fixture()` + `test/helpers/git-fixtures.ts`). Cover: traversal/symlink escapes, binary/oversize, stale-mtime 409, multipart upload, zip round-trip via yauzl, diff vs `git log` sha-for-sha, rename mapping, ref-injection 400s, pagination, git_summary ahead/dirty counts.

### 3.4 Web — Monaco foundation

- Deps: `@monaco-editor/react`, `monaco-editor`, `@radix-ui/react-context-menu`.
- **New `src/features/editor/monaco-setup.ts`** — **self-hosted Monaco** (the react wrapper defaults to a CDN — forbidden: offline hosts): `loader.config({monaco})` with the bundled instance + Vite `?worker` wiring; `defineTheme('puddle', monacoThemeFromCss())` re-applied via `onThemeChange` (mirror `Terminal.tsx`). Imported only from lazy editor chunks (mirror `LazyTerminal.tsx`).
- **New `src/features/editor/buffer-store.ts`** — Monaco models as the buffer store: one model per `(session, path)` at `puddle://<session>/<path>`; editor tab and diff tab's modified side share the model, so a diff-view edit is the editor tab's dirty buffer and one ⌘S saves both. Dirty = `getAlternativeVersionId() !== savedVersionId`, exposed via `useSyncExternalStore`. Also `editorTabLabel()` (branch-suffixed on basename collision — pure, unit-tested).
- **Tokens**: `--diff-added`/`--diff-removed` (translucent, like `--selection`) in both theme blocks of `src/styles/tokens.css`, mapped in `app.css`, added to `REQUIRED_SEMANTIC_TOKENS` in `scripts/check-tokens.mjs` (no contrast floor — backgrounds), consumed in `monacoThemeFrom()` as `diffEditor.insertedTextBackground`/`removedTextBackground` (update its unit test).

### 3.5 Web — drafts + multi-window (user requirements)

- **New `src/lib/drafts.ts`** — IndexedDB store (raw IDB, no dep) keyed `(session, path)` → `{content, base_mtime_ms, updated_at}`. Written debounced ~1 s while a buffer is dirty; cleared on save/discard. On tab open: draft exists and disk mtime === `base_mtime_ms` → restore as dirty buffer with a "restored unsaved changes" badge; disk moved → open disk content with a toast offering **Restore draft**. IndexedDB over localStorage: 5 MiB files exceed localStorage budgets.
- **New `src/features/editor/editor-sync.ts`** — `BroadcastChannel('puddle-editor')`: `{t: 'saved'|'draft-updated'|'draft-discarded', session, path, mtime_ms?}`. On `saved`: other windows refresh a clean model in place; a dirty one badges "saved in another window" (mtime check still guards its ⌘S). On `draft-updated` while locally dirty: both windows badge "also being edited in another window". No live keystroke mirroring (decision: conflict-safe independent).
- **Rework `src/features/workspace/use-ui-state.ts`** — per-window working set: the full snapshot (session_tabs, active_session, editor_tabs, layout, explorer_pin/open, active view) lives in `sessionStorage` keyed `puddle.ws.<projectId>.<profileId>` and is the restore source on window reload; absent (fresh window) → seed from the server snapshot as today. Every `update()` writes sessionStorage immediately and the server row debounced (2 s) — the row stays the freshest cross-machine seed; windows no longer clobber each other's live layout. **Amend SPEC §11** (reload semantics bullet list) accordingly.

### 3.6 Web — explorer, editor tabs, diff, history

Query hooks in **new `src/lib/worktree-queries.ts`** (deliberately not `queries.ts` — concurrent session): `useWorktreeTree`, `useWorktreeFile`, `useSaveWorktreeFile`, `useWorktreeDiff` (10 s poll while mounted + refetch-on-focus), `useFileAt` (staleTime ∞ for shas), `useWorktreeLog` (useInfiniteQuery), `useCommitShow`, plus `uploadFiles`/`downloadPath` on a new `apiFetchRaw` helper added additively to `src/lib/api.ts` (bearer token; a plain anchor can't carry it — download via blob + objectURL click).

- **Explorer** (`src/features/explorer/`): `FileExplorer.tsx` + `TreeNode.tsx` (lazy-expand, mono names, fill-shift hover, no borders), `ExplorerHeader.tsx` (bound worktree/branch in mono, pin toggle, session dropdown — SPEC §8 follow-active/pin via `explorer_pin`), `use-explorer-target.ts`. New owned `components/ui/context-menu.tsx` (Radix, styled with `menuRow`/`menuHighlightRadix`) — right-click: Download, Copy path. Drag-over highlights folder rows; drop → `uploadFiles` → invalidate that dir; folder drops out of v1 (toast). Placement: third resizable `Panel` between session sidebar and main, toggleable, persisted.
- **Editor** (`src/features/editor/`): `EditorTabStrip.tsx` ((session, path) tabs, branch-suffixed labels, dirty dot, discard-confirm on close), `EditorZone.tsx` (top panel of a vertical `Group` inside main — editor above terminal/diff/history; split persisted), `CodeEditor.tsx`/`LazyEditorPane.tsx`. Save: ⌘S with `expected_mtime_ms`; 409 → toast "File changed on disk (probably the agent)" with Reload/Overwrite. Clean tab refocus with moved server mtime → silent refresh.
- **New `src/features/workspace/editor-context.tsx`** — `useEditor().openFile(sessionId, path, {line?, column?})` (precedent: `new-session-context.tsx`); Phase 4's contract; reveals line via `revealLineInCenter` after model load.
- **Views**: routes `/project/:id/session/:sid/diff` and `/history` in `App.tsx`; `ViewStrip.tsx` (Terminal · Diff · History + explorer toggle) in `Workspace.tsx`; terminals stay mounted-but-hidden exactly as today.
- **Diff** (`src/features/diff/`): `DiffView.tsx` (header: base_ref + resolved sha + counts, mono) + `FileDiffSection.tsx` — collapsible per-file `DiffEditor`s, mounted on first IntersectionObserver visibility (no virtualisation dep); `original` = `useFileAt` (404/added → plain editor), `modified` = the shared model, `readOnly: false` — the editable-diff AT path.
- **History** (`src/features/history/`): `HistoryView.tsx` = `CommitList.tsx` (useWorktreeLog, "Show more" on `has_more`) + `CommitDetail.tsx` (useCommitShow; per-file read-only `DiffEditor` of `sha^ → sha`; initial-commit parent 404 → empty original).

### 3.7 Phase 3 docs

SPEC §6 (record merge-base semantics, caps), §8 (already matches), §11 (per-window working set + drafts). CLAUDE.md repo map (+`features/{editor,explorer,diff,history}`). CHANGELOG entries + bump note. **New `docs/acceptance/phase-3.md`**: editor edit → agent `cat` shows it; stale-save conflict drill; diff lists agent changes, hand-edit in diff view → `cat` shows it; history matches `git log` sha-for-sha; drag-in upload appears in worktree; folder download zips without `.git`; pin + reload restores; **two-window drill** (same project in two windows: independent tabs survive per-window reload; save in one refreshes the other's clean view; dual-dirty badges; kill browser entirely → drafts restored from IndexedDB); theme switch restyles Monaco live.

---

## Phase 4 — terminal links (final click-through depends on 3.6's editor-context; the rest is independent)

### 4.1 Daemon + shared

- `resolvePathResponseSchema` `{path /* normalised worktree-relative */, line: number|null}` added to `src/api/worktrees.ts`; minor bump.
- `GET /:sid/resolve?path=&line=` in `routes/worktrees.ts`: relative resolves against the worktree; absolute accepted only inside it; `realpathSync` containment; **files only** (dirs 404 — nothing to open in Monaco); escape/missing → plain 404 `not_found` (client just doesn't underline); 409 `worktree_missing`. Tests in `test/worktree-routes.test.ts` (traversal, symlink escape, absolute-inside, line clamp).

### 4.2 Web — URL links

Add `@xterm/addon-web-links` (**verify the xterm 6-compatible release at install**). Load next to FitAddon in `Terminal.tsx` with `window.open(uri, '_blank', 'noopener,noreferrer')` — one handler covers plain and cmd+click. **Localhost→proxy URL rewriting: defer to Phase 6** (only meaningful in SSH mode; pre-6 the browser origin is the daemon host so localhost URLs already work) — amend SPEC §7's "lands with Phase 5" note in the Phase 5 commit.

### 4.3 Web — file-path link provider

**New `src/features/terminal/file-links.ts`** (pattern: `paste-image.ts`): `registerFileLinks(xterm, sessionId, onOpen)` via `registerLinkProvider`. Wrapped-row logical-line assembly (walk `isWrapped`). Permissive regex requiring an extension or `/`/`./` lead, capturing `:line(:col)?`, trailing-punctuation strip — the server is the validator; false positives only cost a cached probe and never underline. Hover validation via `/resolve` with a module cache (positive TTL 15 s, negative 5 s — agents create files mid-session; in-flight dedupe; ~500-entry cap; ≤4 concurrent). Underline + pointer only on 200. **Activate only on cmd/ctrl+click** (plain click keeps terminal selection; matches the AT gesture). Skipped for `login-*` streams. `Terminal.tsx` gains optional `onOpenFile` prop; `Workspace.tsx` threads `useEditor().openFile`. Unit tests: regex table + cache behaviour (mocked `api`).

### 4.4 Web — open-in-editor deep links

**New `src/lib/editor-links.ts`**: `editorDeepLink('vscode'|'cursor', worktreePath, sshHost|null)` → `ssh-remote+` form with a host, else local `vscode://file/<path>` / `cursor://file/<path>` (write the local form into SPEC §7). Host precedence: client setting ("SSH host for editor links", Settings → Terminal & editor, in `client-settings.ts`) > `?host=` boot param (captured/stripped like the token fragment; CLI sends it from Phase 6) > local. UI: two items appended to `SessionActions.tsx` dropdown (+ optionally the explorer header). Unit tests for the three forms + precedence.

### 4.5 Phase 4 docs

Minor bump + CHANGELOG; SPEC §7 edits (local deep-link form; rewrite → Phase 6). **New `docs/acceptance/phase-4.md`**: real claude session prints a path and URL; both click gestures open the URL; nonsense path never underlines; cmd+click `src/x.ts:42` → Monaco at line 42; deep links local and `?host=` forms.

---

## Phase 5 — ports (daemon side independent; can parallelise with 3/4)

### 5.1 Detection

- **New `src/api/ports.ts`** (shared): `sessionPortSchema` `{port, pid, command, address}`, `sessionPortsResponseSchema` `{ports[], scanned_at}`. One minor bump covers ports + proxy.
- **Edit `src/pty/pty-manager.ts`**: additive `pidsFor(stream): number[]` (agent + shell-N; `IPty.pid`).
- **New `src/ports/process-tree.ts`**: `descendantsOf(roots)` — one `ps -axo pid=,ppid=` exec (identical on macOS/Linux), BFS. Pid-reuse race accepted (one stale row per poll at worst).
- **New `src/ports/scanner.ts`** — `PortScanner`: platform chosen once — darwin `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` (stateful field parse), linux `ss -tlnpH` (`users:(("comm",pid=…))` parse; `[::]:port`/`*:port` forms). Parsers are pure functions over stdout → unit-test with captured fixtures. `scan(sid)`: `pidsFor` empty → `[]` with zero execs; else filter listeners by descendant set; per-session cache TTL 2 s + in-flight dedupe; `hasPort(sid, port)` does the SPEC §9 one-shot fresh re-scan on miss.
- `GET /api/sessions/:id/ports` in `routes/sessions.ts` (empty list for non-live sessions, not an error); `PortScanner` added to `AppDeps.api` (`app.ts`) and constructed in `daemon.ts`.
- Tests (`test/ports.test.ts`): parser fixtures for both platforms; process-tree fixture; live test with `node -e` child listening on port 0 (CI-safe), stubbed `pidsFor`.

### 5.2 Tier-2 proxy

**Mechanism: raw `node:http.request`**, not fetch (fetch can't do WS upgrade, hop-by-hop headers, or Host control; `@hono/node-server` exposes the real `IncomingMessage` as `c.env.incoming` for byte-for-byte piping).

New `src/proxy/` modules:
- **`auth.ts`** — SPEC §2 requires token auth on `/proxy`, but a browser tab navigating there can't send a bearer header. Mechanism (write into SPEC §2): accept bearer header, `puddle_proxy` cookie, or one-shot `?puddle_token=` — the query form 302-redirects to the stripped URL after setting `Set-Cookie: puddle_proxy=<token>; Path=/proxy; HttpOnly; SameSite=Lax` (token never lingers in the address bar — same instinct as the fragment strip). Cookie value is the daemon token itself (a minted second secret adds state, not a boundary). Path-scoping keeps it off `/api` (bearer-only); HttpOnly hides it from same-origin proxied-app JS; SameSite=Lax + the existing `hostOriginGuard` cover cross-site. Timing-safe compares. Plain-function variant `isProxyAuthorised()` reused by the upgrade handler.
- **`http.ts`** — `proxyRoutes({sessions, scanner, tracker})`: `all('/:sid/:port/*')` + bare → 302 trailing slash (relative assets); `Upgrade: websocket` requests return immediately (the raw listener owns them — see below); validate sid (404), port (400 `invalid_port`), `hasPort` (403 `port_not_detected`, after the one re-scan); forward with hop-by-hop headers stripped, `puddle_proxy` cookie pair removed, `host: 127.0.0.1:<port>` (Vite allowedHosts-friendly), raw un-decoded subpath + query; stream request (`c.env.incoming`) and response (`Readable.toWeb`) both ways; `ECONNREFUSED`/5 s connect timeout → 502 `upstream_unreachable`.
- **`upgrade.ts`** — `attachProxyUpgrade(server, deps)`: second `server.on('upgrade')` registered in `daemon.ts` **after** `serve()`. Verified seam in @hono/node-server 2.0.8: its single upgrade listener destroys unclaimed sockets **only when `listenerCount('upgrade') === 1`**, so a second listener disarms that; the Hono app still runs for proxy upgrades, hence http.ts's early return. Match `/proxy/:sid/:port`; non-matches untouched (`/ws` keeps working). Re-apply security by hand: refactor `security/middleware.ts` to export `isLocalHostHeader`/`isLocalOrigin` predicates, then `isProxyAuthorised` (Vite's HMR WS client can't set headers but inherits the page cookie), then `hasPort`. Forward the 101 handshake and pipe both sockets; track pairs in a `ProxySocketTracker` — `daemon.ts` `stop()` calls `tracker.destroyAll()` (upstream sockets aren't covered by `closeAllConnections`).
- **`app.ts`**: `app.use('/proxy/*', hostOriginGuard())` + `proxyAuth(token)` + `app.route('/proxy', proxyRoutes(api))` inside the `if (deps.api)` block (already precedes the static catch-all).
- **SPEC §9 caveats to write down**: proxied apps share the daemon origin (their cookies/storage land there; a hostile dev server could read the token in localStorage — accepted v1, single-trusted-user box); base-path limitation stands (§15.5: no HTML rewriting in v1, `ssh -L` fallback per port).
- Tests: `test/proxy.test.ts` (route-level with stub scanner + throwaway upstream `http.createServer`: auth matrix incl. 302+Set-Cookie+param-strip, 403 + observed single re-scan, path/query/host/hop-by-hop forwarding, POST body, 502); e2e additions (`test/e2e.test.ts` — re-read first): fake-agent variant runs a `node -e` HTTP server printing its port; poll `/ports` until detected (proves pid-tree + scanner end-to-end); fetch through `/proxy` with `?puddle_token=`; WS e2e with a hand-rolled RFC 6455 handshake child (~15 lines) and `new WebSocket('ws://…/proxy/<sid>/<port>/')` — proves the upgrade seam without Vite in CI.

### 5.3 Ports UI

- `useSessionPorts(sessionId, live)` — **append additively to `src/lib/queries.ts` (re-read first — concurrent session)**: `refetchInterval: 5_000`, enabled only for the active, live (`running`/`waiting_input`) session. Polling is the mechanism (no WS port events specced); no refresh button (HUMANS minimalism).
- **New `src/features/ports/PortsStrip.tsx`**: slim mono strip under the terminal region in `Workspace.tsx` (sibling of `SessionBanner`), hidden when no ports. Port chips (tabular numerals, fill-shift hover, tooltip `command · pid`) opening the existing dropdown-menu: **Open localhost** (`http://localhost:<port>`), **Open via proxy** (`/proxy/<sid>/<port>/?puddle_token=` — first hit sets the cookie and redirects clean), **Copy `ssh -L <port>:127.0.0.1:<port> <user>@<host>`** (from the host-info hook in `queries.ts`; toast). All three always shown — pre-Phase-6 the daemon can't know if the browser is behind a manual tunnel. No new colour tokens.

### 5.4 Phase 5 docs

Minor bump + CHANGELOG (`### Added` + `### Security` for the proxy auth design); SPEC §2/§7/§9 write-backs as above. **New `docs/acceptance/phase-5.md`**: agent scaffolds and runs Vite with `--base /proxy/<sid>/<port>/`; strip shows the port ≤5 s; open via proxy renders with a clean address bar + `Path=/proxy` cookie visible; agent edits a file → **HMR updates through the proxy** (the AT); curl without credentials → 401, foreign port → 403; restart on a new port and open immediately → one-shot re-scan avoids the 403 window; daemon stop with an open proxied WS exits cleanly.

---

## Workstream S — shared conversation store (claude-code) + tier-1 migration

Independent of Phases 3–5 (different files), but it touches the hottest concurrent-session files (`agents/claude-code.ts`, `agents/adapter.ts`, accounts routes/stores, `e2e.test.ts`) — **re-read every one at execution time; strictly additive edits**.

### S.1 Canonical store layout and adoption

- **Layout** (add to `src/paths.ts` + SPEC §2 state tree): `~/.puddle/profiles/<profile_id>/sessions/<agent_type>/<store-key>/`, where `<store-key>` is the escaped basename of the project dir Claude Code itself creates under `<config_dir>/projects/` — the observed dir is the share unit (confirmed decision). Each Claude account of the profile holds `projects/<store-key>` as a **symlink** (absolute target) to the canonical dir. Never symlink the whole `projects/` dir.
- **Adopt-after-first-write** — new agent-agnostic manager `src/sessions/conversation-share.ts`, driven by adapter-specific hooks:
  1. Trigger: post-spawn, once the session's conversation exists on disk (poll after `resolveSessionRef`, and again on the first `waiting_input` flip as a backstop). Skip instantly when the containing dir is already a symlink.
  2. Locate the **real** dir under the launching account's `projects/` that contains `<ref>.jsonl` (adapter hook — see S.2).
  3. `rename()` it into the canonical store and leave a symlink behind. Same filesystem (everything under `~/.puddle`), so a live agent's open fd keeps writing to the moved inode, and re-opens by path resolve through the symlink.
  4. Mirror the symlink into the profile's other claude accounts. If a target account already has a **real** dir of that name (it raced adoption with its own session), merge its files into the canonical dir first, then replace it with the symlink.
  5. Serialise all of this through the existing `KeyedMutex` with key `share:<profile_id>:<agent_type>`.
- **Backfill**: `POST /api/accounts` (after `prepareConfigDir`/`importConfigDir`) links every existing canonical store of that (profile, agent) into the new account. **Boot reconcile**: idempotent pass repairing missing/dangling symlinks for all accounts (alongside the existing `reconcileConfigDir` loop).
- **Archive**: delete exactly the session's own files — `<ref>.jsonl` from the canonical dir, plus adapter-listed ancillary per-session files in each account dir (e.g. `todos/<ref>*.json`, which live outside `projects/`) — then remove the canonical dir **and its symlinks only when the dir is empty**. Account deletion removes the config dir, which now holds only symlinks → conversations survive (the goal). Profile deletion already cascades the profile dir including `sessions/` — correct as-is.

### S.2 Adapter surface (agent-specific mechanics stay in the adapter, per CLAUDE.md)

Extend `AgentAdapter` with an optional group, implemented for claude-code in a new `src/agents/claude-share.ts` (keeps `claude-code.ts` under the size seam):

```ts
conversationShare?: {
  /** Real (non-symlink) project dir containing <ref>.jsonl under this account, or null. */
  locateStoreDir(ref: string, account: Account): string | null;
  /** The session's own files: its JSONL within the store dir + ancillary paths per account. */
  sessionFiles(ref: string, account: Account): { inStore: string[]; perAccount: string[] };
}
```

**Verify against the installed Claude Code version and pin in the adapter header** (user-specified):
1. `--resume <uuid>` reads a conversation whose `projects/<dir>` is a symlink.
2. Cross-account resume with ancillary state missing (`todos/` etc. don't follow the symlink) degrades gracefully — record the observed behaviour.
3. Re-verify the worktree-cwd escaping (repo-root vs worktree path) — the observed-dir design works either way, but the finding decides the effective granularity and must stay pinned.

**Known consequence to document** (code comment + CHANGELOG): `usageStats` sums JSONLs through symlinks, so after adoption every account of a profile reports the same totals for shared stores — accepted for the best-effort usage panel.

### S.3 Migration endpoint + UI

- **Shared**: `migrateSessionRequestSchema {account_id}` in `src/api/sessions.ts`; minor protocol bump (SPEC §6 already documents the route).
- **Daemon** (`routes/sessions.ts` + `SessionService.migrate`): `POST /api/sessions/:id/migrate {account_id}` — target must be same profile (400 `cross_profile_account`), same `agent_type` (400 `agent_mismatch`), not the current account (400 `same_account`); kill a live process first; `checkLoggedIn(target)` (409 `account_logged_out`); with a shared store, `hasConversation(ref, target)` must now be true through the symlink → update `sessions.account_id`, resume with the target's env; `skip_permissions` re-evaluated per §11.4 (requested ∧ gate ∧ target opt-in, silent downgrade noted in the terminal); `events` row `migrated {from, to}`. When the adapter has no `conversationShare` (or the symlink check fails): fall back to `migrateSession` (JSONL copy with rollback) and, failing that, 409 `migration_unsupported` — the SPEC §5 fall-through order.
- **Web**: "Move to account…" submenu in `SessionActions.tsx` listing the profile's same-agent accounts (current one disabled), confirm + toast, invalidate sessions. No other UI (limit-triggered "Continue on…" prompts stay in Phase 8).

### S.4 Tests and docs

- **New `test/conversation-share.test.ts`** (fixture + a `fakeAdapter` variant implementing `conversationShare`): adoption moves the dir and the live fake agent keeps appending (file grows in the canonical location); symlink mirrored to a second account; race-merge when both accounts hold real dirs; backfill on account add; archive removes only the session's files and rmdirs when empty; account delete leaves the canonical store intact; boot reconcile repairs a deleted symlink.
- **e2e additions** (`test/e2e.test.ts` — re-read first): full migrate flow — create on account A, exhaust/kill, migrate to B, resume streams the same conversation; gate re-evaluation downgrade; fallback path for a share-less adapter.
- **SPEC updates, same commits**: §2 state layout; §5 tier-1 rewritten (symlink share primary, copy fallback, ancillary-state caveat); §6 migrate implemented; §14 note that tier-1 migration ships ahead of Phase 7 (Phase 7 retains codex/opencode adapters + cross-agent hand-off); §15.2 updated with the verified findings. CHANGELOG `### Added`/`### Changed`. **New `docs/acceptance/tier1-migration.md`**: two logged-in claude accounts on one profile; session on A; verify the canonical dir + symlinks exist after first output; migrate to B → conversation history intact on resume (the SPEC §14 tier-1 AT, run early); archive → only that session's JSONL gone; delete account A → conversations still present under the profile store.

---

## Execution order

1. **Phase 3** (3.1 → 3.7), the bulk. 2. **Phase 4** (4.1–4.2 any time; 4.3–4.5 after 3.6's editor-context). 3. **Phase 5** (daemon 5.1–5.2 can run parallel to 3/4 — disjoint files except `shared/src/index.ts`, `protocol.ts`, SPEC, CHANGELOG; UI 5.3 after). 4. **Workstream S** is independent of all three but collides with the concurrent session's uncommitted files — schedule it when those changes have landed, or coordinate; within it, S.1/S.2 precede S.3. Each phase/workstream = its own commit series with its own protocol minor taken at commit time.

## Error codes introduced

`path_outside_worktree`, `not_a_directory`, `not_a_file`, `stale_file` (409), `file_too_large` (413), `upload_too_large` (413), `nothing_uploaded`, `invalid_against`, `invalid_ref`, `unknown_ref` (404), `not_at_ref` (404), `invalid_pagination`, `invalid_port`, `port_not_detected` (403), `upstream_unreachable` (502), `cross_profile_account`, `agent_mismatch`, `same_account`, `migration_unsupported` (409).

## Verification

- **Unit/route tests** per work item above (`pnpm test`); parser fixtures make lsof/ss/ps coverage CI-safe; `pnpm --filter @puddle/web check-tokens` must pass with the two diff tokens; `pnpm lint`, `pnpm build`.
- **e2e**: extended `test/e2e.test.ts` (ports + proxy incl. WS upgrade with the fake agent's real listeners; migrate flow with the share-capable fake adapter).
- **Manual acceptance**: the new `docs/acceptance/phase-{3,4,5}.md` and `docs/acceptance/tier1-migration.md` scripts against a real claude-code install — daemon started from a plain shell (never inside this session; CLAUDE.md warning). Phase 3's script includes the two-window and draft-restore drills; the migration script includes the symlink-resume and missing-ancillary-state verifications that must be pinned in the adapter.
