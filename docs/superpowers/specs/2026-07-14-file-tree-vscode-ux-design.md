# File-tree VSCode-grade UX — design

Date: 2026-07-14
Status: approved (brainstorming), pending implementation plan
Scope: sub-project 1 of the "richer file tree & editor" arc (see _Sequencing_ below)

## 1. Context & goal

Puddle's file explorer (`packages/web/src/features/explorer/`) is currently minimal:
a lazily-loaded per-directory tree with a two-item context menu (Download, Copy
path), native-HTML5 drag used only for uploading external files onto folders, and
no git awareness. The editor side treats every non-text file as a "Binary —
Download" fallback.

This spec brings the **file tree** up to VSCode parity: rich context menus on
files, folders and empty space; full git-status decorations; real file operations
(create, rename, move, copy, delete) with a tree clipboard; multi-select;
arrow-key navigation; a file-type icon theme; and a header utility bar with a
hover-marquee branch title.

The backend today has **no** create/rename/copy/delete endpoints and **no**
git-status-per-path endpoint, so this spec adds those first; the frontend work
consumes them.

### Sequencing (the larger arc, for reference)

The user's overall request decomposes into five sub-projects, each its own
spec → plan → build cycle:

1. **This spec** — file-operation backend + file-tree UX.
2. _(folded into this spec)_ — the tree UX consumes sub-project 1's backend.
3. Rich file viewing — inline image/video/audio/PDF preview as editor tabs
   (needs a new content-type-aware inline media endpoint). **Out of scope here.**
4. Editor keybindings — VSCode bindings incl. `⌥Z` line-wrap toggle. **Out of scope.**
5. Free-form tiling/dock layout — drag any window anywhere, split panes.
   Large, risky, **its own later project**. Eventual target: full tiling/dock.

Explicitly **out of scope for this spec**: media/PDF preview, editor keybindings,
tiling layout, and "Open to the Side" (which needs the editor-group split from
sub-project 5).

## 2. Backend

All routes mount under `/api/worktrees/:sid` alongside the existing
`worktree-files.ts` / `worktree-git.ts` handlers. Every path argument is confined
to the worktree root by the **same path-safety resolver** the current `/file` and
`/download` endpoints use — any argument resolving outside the worktree is a 400,
covered by a test. Schemas are new zod definitions in `packages/shared/src/api/`;
the daemon validates input, the web imports the inferred types (never a
locally-defined shape). All additions are **additive → minor `PROTOCOL_VERSION`
bump** per `packages/shared/PROTOCOL.md`, in the same commit as the code.

### 2.1 Git-status endpoint (new)

`GET /api/worktrees/:sid/git-status` → `{ entries: GitStatusEntry[] }`.

- `GitStatusEntry = { path: string; status: GitStatus }`.
- `GitStatus = 'untracked' | 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted' | 'ignored'`
  — a **new** `gitStatusSchema` in shared. The existing `diffStatusSchema`
  (`added|modified|deleted|renamed`, used by the changes view) is left untouched;
  the tree needs the richer set (distinct `untracked`, `conflicted`, `ignored`).
- Backed by `git status --porcelain=v1 -z --ignored=matching --untracked-files=all -M`,
  run in the worktree. Map the XY status codes to the enum with this precedence
  when both columns disagree: **conflicted** (`U*`, `AA`, `DD`) > **added** (`A`),
  **untracked** (`??`) > **renamed** (`R`) > **modified** (`M`/`T`) >
  **deleted** (`D`) > **ignored** (`!!`). The porcelain parse (byte stream →
  entries, letter → enum, precedence) is a pure, unit-tested function in
  `packages/daemon/src/worktrees/` (alongside `inspect.ts`).
- `--ignored=matching` reports only ignored paths that actually exist, so the tree
  can grey them without walking every ignore rule.

The web adds a `useWorktreeGitStatus(sid)` TanStack query (polled ~10s, mirroring
`useWorktreeDiff`) that reduces the entries into a `Map<path, GitStatus>`.

### 2.2 File-operation endpoints (new)

A new route module `packages/daemon/src/http/routes/worktree-fs-ops.ts`:

| Route | Body | Behaviour |
|-------|------|-----------|
| `POST /:sid/create` | `{ path, kind: 'file' \| 'dir' }` | Create an empty file / `mkdir -p` the folder; **409** if it already exists. |
| `POST /:sid/rename` | `{ from, to }` | Single `fs.rename` — serves both rename and move (paste-cut, drag-move). **409** if `to` exists. |
| `POST /:sid/copy`   | `{ from, to }` | Recursive `fs.cp`; auto-suffix `to` (` copy`, ` copy 2`, …) if it collides, returning the final path. |
| `POST /:sid/delete` | `{ path }`     | Recursive remove (no trash on the host). |

Each returns `{ ok: true }` plus, where useful, the resulting `path` (copy's
resolved name). New request/response schemas per route in shared. No new WS
traffic: after a mutation the web invalidates the affected `wt-tree` directory
query (and the git-status query) exactly as `uploadFiles` already does; edits made
by concurrent agents in the same worktree surface on the next tree/status poll.

## 3. Frontend

### 3.1 Shared visible-row model (enabler for multi-select + arrow-nav)

Multi-select ranges and arrow navigation both need the tree as a **flat, ordered
list of currently-visible rows**. Introduce `use-visible-rows.ts` (or extend the
explorer context) that flattens the loaded-and-expanded tree into an ordered
`VisibleRow[] = { path, kind, depth }` — derived from the `expanded` set plus the
already-cached `useWorktreeTree` data for each expanded directory. This list is
the backbone for keyboard focus, range selection, and paste-target resolution.
The recursive `DirEntries` rendering stays; the flat list is a parallel index.

### 3.2 Selection & clipboard model (in `ExplorerCtx`)

- `selection: { anchor: string \| null; paths: Set<string> }`. Plain click selects
  one (and opens files); `⌘/Ctrl-click` toggles a path; `⇧-click` selects the range
  between anchor and target using the visible-row order.
- `clipboard: { paths: string[]; mode: 'cut' \| 'copy' } \| null` — ephemeral React
  state, not persisted. `Cut`/`Copy` snapshot the current selection into it; `Cut`
  rows render dimmed until the clipboard clears.
- `Copy Path` / `Copy Relative Path` write text to the OS clipboard
  (`navigator.clipboard`) — path is worktree-absolute, relative is
  worktree-root-relative.
- `Paste` resolves a **target folder** (the clicked folder, or the parent folder of
  a clicked file, or root for empty space) and, per clipboard path, calls `/copy`
  (copy mode) or `/rename` (cut mode). Cut clears the clipboard after a successful
  paste; then invalidate the touched directories + git-status.

### 3.3 Git decorations (`TreeNode`)

Overlay the git-status map onto each row:

- Filename text takes a status colour; a trailing right-aligned one-letter badge
  is shown (matching image #4): **U** untracked · **A** added · **M** modified ·
  **D** deleted · **R** renamed · **C** conflicted. Ignored rows dim to
  `text-fg-muted` with **no** badge.
- Colours come from **new git tokens** added to `packages/web/src/styles/tokens.css`
  (single colour source, guarded by `scripts/check-tokens.mjs`), semantically:
  untracked/added → green, modified/renamed → amber/gold, deleted/conflicted → red,
  ignored → muted. A small pure `git-decoration.ts` maps `GitStatus →
  { letter, colourClass }` (unit-tested), the tree analogue of `diff-status.ts`.
- **Folder roll-up**: a folder shows the highest-precedence status among its
  descendants as a colour tint (no letter), computed client-side from the flat
  status map. Precedence reuses §2.1's ordering.

### 3.4 File-type icon theme

Replace the single lucide `File` glyph with a **permissively-licensed (MIT)**
per-extension/filename icon set (e.g. the Material or Seti icon theme — no
AGPL-sourced assets, per the repo's licensing rule). Icons are bundled as inlined
SVGs and mapped by filename → extension → default. These icons carry their own
multi-colour artwork, which is a **documented exception** to the "no colour outside
tokens.css" rule (like third-party brand glyphs); note it in `tokens.css`'s guard
comment and `SPEC.md §12` so reviewers and `check-tokens.mjs` expect it. Folder
open/closed glyphs stay lucide (monochrome, token-coloured).

### 3.5 Context menus

Built on the existing `components/ui/context-menu`. Three variants:

- **File row**: `Copy Path` · `Copy Relative Path` · `Cut` · `Copy` · `Paste` ·
  `Rename…` · `Delete` · `Download`.
- **Folder row**: `New File…` · `New Folder…` · `Cut` · `Copy` · `Paste` ·
  `Copy Path` · `Copy Relative Path` · `Rename…` · `Delete` · `Download`.
- **Empty space** (`FileExplorer` root, image #3): `New File…` · `New Folder…` ·
  `Paste` · `Copy Path` · `Copy Relative Path` · `Download worktree`.

Dropped as inapplicable to a remote-web worktree: Reveal in Finder, Open With,
Share, Open Timeline, Add to Chat, Select for Compare, Open in Integrated Terminal,
Add Folder to Workspace, Find in Folder, Python Project. `Open to the Side` is
deferred to sub-project 5 (needs editor split groups). When a menu item acts on a
multi-selection, it applies to the whole selection.

### 3.6 Inline create / rename; delete confirm

Fits HUMANS.md (avoid dialog boxes where an inline affordance works):

- **Rename** swaps the row's label for an `<input>` pre-filled with the name,
  basename pre-selected (extension excluded). Enter commits (`/rename`), Esc
  cancels, blur commits.
- **Create** inserts a temporary input row under the target folder (auto-expanding
  it); Enter commits (`/create`), Esc removes the row.
- **Delete** is the one modal: a minimal confirmation reusing the existing dialog
  primitive (there is no host trash, so deletion is irreversible) — worded with the
  target name / count.

Optimistic where safe, always followed by query invalidation; failures surface as a
`toast.error` and roll back.

### 3.7 Keyboard & arrow navigation

Roving-tabindex over the flat visible-row list; the tree container owns the
handler:

- `↑`/`↓` move focus; `→` expands a collapsed folder (or steps into the first
  child), `←` collapses (or steps to the parent); type-to-jump matches by prefix.
- `Enter`/`F2` rename · `Delete`/`⌘⌫` delete · `⌘C` copy · `⌘X` cut · `⌘V` paste ·
  `⌥⌘C` copy path · `⌥⇧⌘C` copy relative path.
- `Space`/`Enter` on a file opens it; on a folder toggles it (current behaviour
  preserved). `⌘/Ctrl` and `⇧` modify selection as in §3.2.

### 3.8 Header utility bar + hover-marquee title (`SidebarTargetHeader`, files mode)

- A right-aligned, hover-revealed action cluster: **New File · New Folder ·
  Refresh** (invalidate tree + git-status) **· Collapse All** (clear the `expanded`
  set). Buttons follow HUMANS.md — no borders, `text-fg-muted` → `text-fg` +
  `bg-elevated` fill-shift on hover, cursor change.
- The branch title (`flex-1 truncate`) becomes a **hover-marquee**: when it
  overflows (`scrollWidth > clientWidth`) and the action icons occlude its tail,
  hovering eases the title's content leftwards (CSS `transform: translateX`
  transition) to reveal the tail, easing back on leave. Purely presentational, no
  layout shift.
- These actions render only in files mode; changes/search/worktrees headers are
  unchanged. The actions are wired from the bound `session` + query client (create
  targets the worktree root).

## 4. Testing

Vitest (pure, Monaco/DOM-free where possible):

- porcelain byte-stream → `GitStatusEntry[]` parse + precedence mapping (§2.1)
- `git-decoration.ts` status → letter/colour, and folder roll-up precedence (§3.3)
- clipboard/paste target resolution + cut-vs-copy endpoint choice (§3.2)
- visible-row flattening + range-selection between two paths (§3.1–3.2)
- copy auto-suffix collision naming (§2.2)

Daemon route tests: create (incl. 409), rename/move, copy (incl. auto-suffix),
delete, and the **escape-the-worktree rejection** for every op.

## 5. Docs & protocol discipline (per CLAUDE.md)

Same commit(s) as the code:

- `packages/shared` schema additions + `PROTOCOL_VERSION` **minor** bump +
  `PROTOCOL.md` note.
- `SPEC.md §8` (file explorer) and §12 (UI conventions — the icon-theme colour
  exception) updated to match.
- `CHANGELOG.md` `[Unreleased]` — `Added` entries for the endpoints and tree UX.
- Any adapter/agent surface untouched (this is core, agent-agnostic).

## 6. Open risks / notes

- **Arrow-nav + recursive rendering**: the flat visible-row list must stay in sync
  with lazily-loaded directory data; a folder expanded but not yet loaded
  contributes no child rows until its query resolves — navigation must tolerate the
  transient gap.
- **Icon-theme bundle size**: inlining a full icon set could bloat the web bundle;
  the plan should tree-shake to the mapped subset or lazy-load the icon map.
- **Concurrent agents** editing the same worktree: all freshness is poll-based
  (~10s) — acceptable, and consistent with the existing diff view; never stash or
  reset on their behalf.
