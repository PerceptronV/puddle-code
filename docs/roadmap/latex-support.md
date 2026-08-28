# LaTeX compilation and inverse PDF synchronisation

Status: protocol 17.1 foundation implemented; remaining hardening roadmap

## Difficulty assessment and v1 boundary

The useful first version is achievable without embedding a TeX distribution or
adopting a heavyweight editor framework. Its main pieces are medium-to-high
complexity but have clean seams: host discovery and safe command recipes are
medium, daemon-side eager observation/coalescing is medium, durable restart
recovery is high, and owned PDF rendering plus inverse SyncTeX is medium-high.
PDF.js is the one substantial dependency; using the host's existing
`latexmk`/Tectonic/engines avoids a much larger compiler/runtime dependency.

Protocol 17.1 implements the practical foundation described in `SPEC.md` §8:
generic advertised providers, on-demand and eager tab modes, client-restored
in-memory eager registrations, debounced dependency watching with a stat
fallback, coalesced runs, managed per-run LaTeX output with last-good promotion,
lazy PDF.js, and confined inverse SyncTeX. Compile mode is persisted in ordinary
UI tab state and is active while the source remains represented in that live
layout; closing the final eager tab retires observation. The daemon does not yet
persist eager registrations in SQLite or recover them before a cockpit
reconnects. The stronger persistence/restart/cancellation/event model below is
the follow-up design, not a description of the 17.1 wire behaviour. `SPEC.md`
remains authoritative for what is currently implemented.

## Outcome

Puddle will treat a `.tex` file as compilable when the machine running
`puddled` has a usable local LaTeX toolchain. Compilation is not another
Markdown/HTML preview mode: the tab strip shows a small compile control in the
preview-control position, and a successful build opens the generated PDF as an
ordinary, persistent Puddle file tab. Each source is either on-demand, compiling
only when explicitly requested, or eager, compiling after daemon-observed input
changes including writes made by coding agents.

All compiler output, including the PDF, SyncTeX data, logs and intermediate
files, lives under `~/.puddle/latex/` on the daemon host. A build must not add or
modify generated files in the project, worktree or browsed external root.

Generated LaTeX PDFs use an owned, lazily loaded PDF.js viewer so Puddle can map
a primary-modifier click back to a source position with inverse SyncTeX. Other
PDFs retain the existing native iframe viewer. LaTeX source and generated PDF
tabs remain ordinary file tabs; there is no new layout-tree tab kind.

This feature is host-relative. A cockpit connected over SSH reports and uses the
remote daemon's toolchain, regardless of what is installed on the browser
machine. The same project may consequently offer compilation on one host and
not on another.

LaTeX is the first implementation of a generic compilation-provider contract,
not a special case embedded in editor, route or watcher code. The common core
owns per-source modes, build scheduling, process limits, managed outputs and
events. A provider owns source recognition, local-tool discovery, entry-point
resolution, command planning, dependency collection, diagnostics and output
descriptions. Future Python, C++ or other providers can reuse the lifecycle
without acquiring LaTeX concepts. PDF.js and SyncTeX remain deliberately
LaTeX-specific integrations.

## Supported hosts and capability discovery

The daemon's compilation-provider registry owns tool discovery and caches a
normalised capability result for each provider. It
refreshes that result when the daemon starts and after an explicit capability
refresh; the web client must not infer support from its own operating system.
Linux and macOS are supported, with WSL treated as Linux. Native Windows remains
outside Puddle's present daemon support, although a MiKTeX installation visible
inside WSL is valid.

Discovery checks executable files without invoking a shell. It searches, in
order:

1. the daemon's effective `PATH` and Puddle's configured executable search
   directories;
2. conventional TeX Live, MacTeX, TinyTeX and MiKTeX binary locations for the
   current host, including versioned and architecture-specific TeX Live paths;
3. resolved companion executables alongside an already discovered TeX binary.

Conventional paths are a recovery mechanism for sparse launchd, systemd and SSH
supervisor environments, not a fixed installation list. Discovery must tolerate
missing directories and must never scan an entire filesystem. Executables are
validated by a bounded version probe, and unchanged results are reused rather
than spawning probes on every render or compile.

The LaTeX provider's reported capability includes:

- the selected runner (`latexmk`, `tectonic` or `engine`);
- the installed engines (`pdflatex`, `xelatex` and/or `lualatex`);
- available bibliography helpers (`biber` and `bibtex`);
- whether the `synctex` query command is present; and
- a concise unavailable reason when no viable runner exists.

The LaTeX provider prefers these backends:

1. `latexmk`, because it owns reruns and bibliography orchestration;
2. Tectonic, when `latexmk` is unavailable;
3. a bounded raw-engine recipe using the locally available TeX engines.

Puddle does not install TeX, packages or bibliography tools. Tectonic retains
its configured bundle/cache behaviour, including any package download it would
normally perform; this is exposed in build output rather than hidden by Puddle.
The upstream command contracts are documented by the
[latexmk manual](https://tug.ctan.org/support/latexmk/latexmk.pdf) and the
[Tectonic compile reference](https://tectonic-typesetting.github.io/book/latest/v2cli/compile.html).

## Compilation-provider boundary

The daemon exposes a registry of `CompileProvider` implementations. The generic
orchestrator depends only on a provider identifier and these responsibilities:

- declare supported source extensions and probe a host-local capability;
- resolve an invoked source to a canonical entry source;
- plan one or more bounded process invocations in a managed build directory;
- parse normalised diagnostics and enumerate project-local input dependencies;
- describe promoted outputs by role, media type and ordinary rooted file
  reference; and
- optionally expose a provider-specific source-navigation capability.

The generic core owns persisted source registrations, compile mode, watcher
lifecycle, debounce/coalescing, cancellation, build identifiers, status events,
resource limits, log capture, atomic output promotion and retention. It never
branches on `.tex`, PDF, `latexmk` or SyncTeX. The LaTeX provider uses the
provider-specific `~/.puddle/latex/` namespace; a future provider receives its
own namespace under `~/.puddle` and cannot collide with LaTeX document hashes.

The web client consumes generic provider capability and build-state models to
render compile controls and ordinary output tabs. Output-specific rendering is
selected separately from compilation: the LaTeX provider can identify its
primary PDF as a managed LaTeX PDF, while a future C++ provider might expose a
log or executable without importing PDF.js. Provider-specific UI is confined to
an optional, lazy output renderer or source-navigation adapter.

## Document root and engine selection

The file whose play control was invoked is the entry file unless Puddle safely
resolves a containing document. Root selection is deterministic:

1. honour a leading `% !TEX root = …` directive;
2. use the selected file itself when it contains `\documentclass`;
3. reuse a previous successful manifest that identifies the file as an input;
4. perform a bounded search inside the same Puddle file root for a unique main
   document that includes the selected file; and
5. fall back to compiling the selected file, allowing the compiler to return a
   useful diagnostic.

The root directive is resolved relative to the selected file, canonicalised,
and accepted only when it remains within the selected Puddle file root. Cycles,
missing files, ambiguous roots and paths outside that root produce an explicit
error rather than an arbitrary choice.

A leading `% !TEX program = …` directive may select `pdflatex`, `xelatex` or
`lualatex`. Values are normalised through a fixed allow-list; they are never
interpreted as executable paths, flags or shell text. Without a directive,
Puddle reuses the last successful engine for the document, then applies modest
source heuristics such as preferring XeLaTeX or LuaLaTeX for `fontspec`, and
finally chooses the best available default (`pdflatex`, then `lualatex`, then
`xelatex`). An explicit engine remains subject to local availability.

For `latexmk`, the engine selection is expressed through its supported engine
mode rather than interpolated into a command string. The Tectonic backend is
selected only when the document does not explicitly require an incompatible TeX
engine.

## Build storage and execution

Each document has a stable directory derived from a versioned hash of its
canonical Puddle root and canonical main-source path:

```text
~/.puddle/latex/<document-hash>/
├── current/
│   ├── document.pdf
│   ├── document.synctex.gz
│   ├── build.log
│   ├── manifest.json
│   └── auxiliary files
└── runs/
    └── <build-id>/
```

The stable `current/document.pdf` path is the identity used by the file tab.
Compilation happens in a fresh `runs/<build-id>` directory. A successful run is
promoted atomically to `current`; a failed or cancelled run preserves the last
successful PDF and manifest. Managed old runs are pruned with bounded retention.

The compiler process runs with its working directory inside the new build
directory, never inside the source tree. Puddle supplies the main input as a
canonical path and configures TeX/Kpathsea input search paths for the main-file
directory and the selected Puddle root while preserving the distribution's
default paths. Bibliography and graphics lookup receive equivalent source-root
search paths. Output is confined to the build directory with the runner's
output-directory option and restrictive TeX output policy. Shell escape is off
by default.

The main recipes are:

- `latexmk`: no repository-controlled rc files, selected PDF engine, SyncTeX,
  nonstop/file-line diagnostics, and the build output directory;
- Tectonic: untrusted mode, SyncTeX, retained logs/intermediates and the build
  output directory; and
- raw engine: nonstop interaction, halt-on-error, file-line diagnostics,
  SyncTeX, no shell escape and the build output directory.

The raw fallback is deliberately bounded rather than pretending to reimplement
all of `latexmk`. It runs an engine until relevant auxiliary-file hashes
stabilise, with a maximum of five engine passes. A `.bcf` requests at most one
`biber` phase; bibliography markers in `.aux` request at most one `bibtex` phase.
The engine is rerun after that phase. Missing helpers produce a diagnostic that
names the absent executable.

Every process is spawned as an argument array without shell interpolation. The
daemon applies a wall-clock timeout, an output-size limit, cancellation and
process-group termination. Builds are serialised per document; a new request
may replace a queued request but cannot race promotion with an active one. The
manifest records the source root, main source, runner and versions, selected
engine, input files reported by the build, PDF identity, SyncTeX identity, build
time and result. User-authored arbitrary compiler flags are not accepted in the
first version.

These constraints prevent normal compiler and package output from contaminating
the repository. Disabling shell escape and restricting TeX output also prevent a
document from turning the compile button into an implicit general-purpose
command runner. Puddle must still treat compiler input as untrusted enough to
enforce resource bounds; the daemon already runs with the user's filesystem
authority and must not claim stronger isolation than it provides.

## Unsaved source

Compilation consumes files on the daemon filesystem, so the play action is also
a save-before-build boundary. Before sending the compile request, the web client
saves:

- the selected source buffer; and
- every dirty, open TeX-family buffer (`.tex`, `.bib`, `.sty`, `.cls` or `.bst`)
  within the same Puddle file root.

The compile does not begin until those writes succeed. A save conflict or failed
write leaves the PDF untouched and reports the failure beside the compile
control. This covers unsaved multi-file documents without inventing a parallel
shadow filesystem, while unopened dependencies are already represented by their
on-disk contents.

Eager compilation observes daemon-side filesystem changes, not unsaved Monaco
model changes. Saving in Puddle therefore triggers the same path as an agent,
formatter or external process writing the file. Enabling eager mode first runs
the save-before-build boundary above; subsequent builds consume each settled
on-disk state.

## Per-source compile modes

Compile mode belongs to the canonical provider source, not to an individual tab
copy. Its key is the provider identifier plus canonical Puddle file root and
canonical entry source. The daemon persists it in SQLite so duplicate tabs,
browser reloads, daemon restarts and SSH reconnections agree. A source with no
record starts in **on-demand** mode; Puddle never opts a repository into
background compilation merely because a compiler is installed.

The two modes have distinct tab-strip controls:

- **On-demand** uses a play triangle. Its primary action compiles once.
- **Eager** uses a live/lightning mark. Its primary action requests an immediate
  rebuild, while the mark communicates that disk changes also rebuild.

The icon is a compile action, not an ambiguous mode cycle. The tab context menu
contains `Compile mode` with mutually exclusive `On demand` and `Eager` items,
and the same two commands are keyboard/command-palette accessible. Selecting
eager persists the mode, starts observation and requests one immediate eager
build. Selecting on-demand persists the mode, cancels any debounce timer and
queued or running watcher-triggered build, tears down its watcher, and retains
the last successful output. Selecting the active mode is a no-op. An explicit
icon click always bypasses the change debounce and is reported as a manual
trigger, even while the source is configured eager.

The daemon creates filesystem observers only for persisted eager sources. It
does not watch every supported extension or an entire repository merely because
a provider is available, and historical on-demand build records never create
observers. Each eager observer initially covers the canonical entry source.
After a partial or successful build, the provider replaces that set with
project-local inputs from its recorder/manifest—LaTeX uses `.fls` and other
build metadata—while excluding TeX-distribution and managed-output paths.
Parent-directory observation with exact file filtering must catch atomic-save
rename patterns as well as direct writes. An eager registration remains active
after its tab closes because closing a view must not silently change a persisted
compile mode; switching to on-demand or removing the source/root is the explicit
teardown.

Watcher bursts are coalesced per canonical source. The initial policy is a
300 ms quiet-period debounce with a two-second maximum latency, expressed as
named constants so measurement can tune them. A second event resets the quiet
period but not the maximum. If an observed input changes during a build, that
now-stale process group is cancelled and exactly one replacement build is
scheduled for the latest settled state. Events accumulated during cancellation
coalesce into that replacement. Output promotion cannot race: only the newest
non-cancelled build identifier may become `current`.

On clean daemon shutdown all observers and compiler process groups are closed.
At startup the daemon loads eager registrations, revalidates the provider and
canonical root, restores the last known dependency set, and resumes observation.
An unavailable toolchain or temporarily absent root suspends rather than deletes
the mode; capability refresh, placement materialisation or root reappearance
retries it. After validation, the daemon compares recorded dependency identity
and modification metadata with the last successful manifest: changes made while
Puddle was stopped coalesce into one recovery build, while an unchanged source
only reattaches its observer. Confirmed worktree/root removal tears down the
observer and marks the registration unavailable without following a reused path
to unrelated content. Recovery never starts an eager build until the capability
and source identity have both been revalidated.

## Tab and compile-control behaviour

A `.tex` tab remains a Monaco source tab. When the connected daemon reports a
usable LaTeX runner, the minimal play or live control for its persisted mode
appears where Markdown and HTML tabs show their preview controls. It follows the
same spacing, translucency and hover language, without introducing a bordered or
filled box. During a build it shows progress and offers cancellation without
losing the underlying mode indicator. When no runner exists, the source remains
editable and the compile control is absent; command-palette discovery may
explain which tools were searched.

LaTeX never participates in the Markdown/HTML source, linked-preview or
locked-preview modes. On-demand compilation is manual; eager compilation is
driven by the bounded provider watcher described above. Neither mode implies an
editor/preview scroll link.

On a successful build:

1. invalidate any cached bytes and metadata for the stable PDF file reference;
2. search every leaf in the current layout tree for that exact rooted file
   reference;
3. if absent, add an ordinary, persistent external PDF file tab to the leaf in
   which play was invoked, and select it; or
4. if already present anywhere, do not duplicate or move it—select its existing
   leaf and refresh it in place.

Those selection rules apply to a manual compile. A watcher-triggered eager
success never changes the active leaf, tab or editor focus. If its PDF is already
open anywhere, it invalidates and refreshes that one tab in place while
preserving page, zoom and selection. If absent and the source is open, it adds
one persistent PDF tab in the source's associated leaf in the background; when
the source appears in several leaves, the most recently associated leaf wins.
If no UI currently contains the source, the daemon records and announces the
successful output but does not guess a pane; the next client reconciliation can
add it in the background beside an opened eager source. Every client performs a
whole-layout rooted-file-reference check immediately before insertion, so eager
events and concurrent panes cannot spawn duplicate tabs.

The PDF tab is never italicised and has the same close, move, split and restore
behaviour as any existing Puddle file tab. Its file root points at the managed
document build directory returned by the daemon. Layout persistence therefore
stores an ordinary external file reference rather than a LaTeX-specific tab.

A failed build keeps the previous successful PDF visible. The play control
returns to its idle state and exposes a concise error containing the first
actionable file/line diagnostic plus an affordance to open the complete managed
`build.log`. Successful rebuilds refresh an existing viewer without resetting
its page and zoom when possible.

## Generated PDF viewer

The existing native iframe remains the default for unrelated PDFs. Before
choosing a viewer for a PDF file reference, the web client asks the daemon for
managed-LaTeX output metadata. A positive manifest match selects a
`LatexPdfViewer` loaded through a dynamic import; a normal PDF never downloads
that chunk. Within the component, `pdfjs-dist` and its matching locally bundled
worker are also loaded lazily. No CDN or browser-machine service is required.

This preserves the ordinary file-tab model while making viewer choice durable
across layout restoration and browser reloads. The generated-output metadata
query is authoritative; path suffixes and client-memory registries are not.

The initial owned viewer needs page rendering, scroll, zoom, text selection,
keyboard accessibility and preservation of view state across a PDF refresh. Its
visual treatment follows `HUMANS.md`: document chrome is minimal and controls
appear responsively rather than surrounding the page with permanent boxes.
PDF.js' maintained rendering and coordinate APIs are described in the
[official examples](https://mozilla.github.io/pdf.js/examples/).

## Inverse SyncTeX

A primary-modifier click in a managed LaTeX PDF performs inverse search. The
browser owns the rendered page, so the event supplies an exact page and point:

```text
PDF.js viewport click
  -> PDF page number + PDF-space x/y
  -> daemon inverse-search request for the managed PDF
  -> synctex edit -o <page>:<x>:<y>:<pdf>
  -> canonical input path + one-based line/column
  -> existing root-aware source-tab reveal
```

PDF.js converts CSS/view coordinates to PDF coordinates with the current page
scale and rotation before the request. The daemon does not accept an arbitrary
PDF path: it resolves the requested output through its successful manifest,
requires the matching `.synctex.gz`, runs the discovered `synctex` command in the
managed build directory, and parses the first valid result. The SyncTeX model
and inverse-query semantics are described in the
[SyncTeX paper](https://www.tug.org/TUGboat/tb29-3/tb93laurens.pdf).

The returned `Input` is canonicalised and must belong to the manifest's selected
Puddle root. It may be the main file or any included `.tex` file: inverse search
must not collapse multi-file documents back to the root document. The web client
uses the existing root-aware reveal path to select a matching source tab in any
leaf or open an ordinary source tab when absent, then positions and focuses
Monaco at the returned line and column.

If SyncTeX was not generated, the query command is unavailable, or the result
falls outside the allowed root, the viewer leaves the current selection intact
and reports a small, actionable message. A normal click continues to select or
pan; modifier-clicking a PDF link follows the viewer's link behaviour rather
than issuing an inverse query.

The PDF.js coordinate conversion and CLI query must be verified against real
documents at multiple scales, rotations and page sizes. LaTeX Workshop is a
useful behavioural reference for the combined PDF.js/SyncTeX interaction, but
Puddle will not copy its implementation. See its
[viewer documentation](https://github.com/James-Yu/LaTeX-Workshop/wiki/View).

## Protocol and module boundaries

All new wire shapes live in `packages/shared` and are validated by the daemon.
The additive API work requires the corresponding minor `PROTOCOL_VERSION` bump
under `packages/shared/PROTOCOL.md`. The shared contract covers:

- daemon-host compilation-provider capabilities, with an extensible provider
  identifier and provider-owned detail payload;
- canonical source registrations and persisted `on_demand | eager` mode;
- generic compile and cancel requests with manual, eager-change and recovery
  trigger reasons;
- generic build state/events, normalised diagnostics and rooted output-file
  descriptors;
- managed-output metadata used to select an optional lazy renderer; and
- a LaTeX-specific inverse-SyncTeX request and rooted source-position response.

Provider identifiers are strings validated against the daemon's advertised
registry rather than a closed LaTeX-only enum. Common request/result fields do
not assume one source extension or PDF output. Provider-specific details use a
versioned discriminated payload, so adding Python or C++ support does not change
the generic build lifecycle or overload LaTeX fields with unrelated meanings.

The daemon implementation is split by responsibility: a generic compilation
registry/orchestrator owns modes, watchers, scheduling, process limits and
promotion; the LaTeX provider owns bounded TeX discovery, safe document-root
resolution, recipe planning, TeX diagnostics/dependencies and SyncTeX querying.
Generic route handlers must not contain tool-specific command construction. The
web implementation similarly separates generic compile controls/build state and
global output-tab lookup from the LaTeX generated-PDF query and lazy viewer.

No layout schema or file-tab discriminator is added. If the ordinary rooted
external file reference cannot address `~/.puddle/latex` on a given host, the
file-access layer is extended through the shared protocol rather than encoding
daemon absolute paths directly into browser-owned state.

## Verification

CI must not require a full TeX distribution. Unit and integration coverage uses
temporary fake executables and fixture outputs to prove:

- a second fake provider can register, report capability, build a non-PDF output
  and use the common scheduler without importing LaTeX code;
- discovery precedence, standard-path recovery, version-probe caching and the
  unavailable state;
- root/program directive parsing, canonical-path confinement, ambiguity and
  engine allow-listing;
- exact argument arrays for `latexmk`, Tectonic and each raw engine;
- bounded raw reruns, bibliography selection, timeout, cancellation, output
  truncation and atomic promotion;
- the invariant that every generated path is below `~/.puddle/latex` and no
  project path changes during a build;
- save-before-build ordering and failure behaviour;
- default on-demand mode, per-source persistence across duplicate tabs and
  daemon restart, explicit mode toggles and capability/root suspension;
- eager dependency observation for direct writes and atomic renames, including
  agent-originated writes that never pass through the web client;
- debounce quiet/max windows, burst coalescing, stale-build cancellation,
  latest-build-only promotion, watcher teardown and restart recovery;
- first-open placement, persistent tabs, global cross-leaf deduplication and
  in-place refresh;
- eager background open/refresh without focus changes, including concurrent
  events and absence of a currently open source tab;
- absence of Markdown/HTML linked modes for TeX;
- lazy PDF.js selection only for manifest-backed generated PDFs;
- PDF-to-SyncTeX coordinate requests, result parsing, multi-file source reveal
  and rejection of paths outside the file root; and
- protocol validation plus the required version bump.

An opt-in real-tool acceptance script covers macOS MacTeX/TeX Live, Linux TeX
Live or TinyTeX, Tectonic-only, raw-engine-only, sparse supervisor `PATH`, remote
SSH and no-tool hosts. It includes paths with spaces and non-ASCII characters,
multi-file documents, bibliography, failed builds and inverse search on rotated
and scaled pages. An eager-mode case edits both a main file and an included file
from outside the cockpit and proves one coalesced rebuild without focus theft or
duplicate tabs. Restart coverage proves mode and watcher recovery. The final
check records `git status` before and after building and requires no project-tree
output. Installed tool versions are included in the acceptance result.

## Delivery sequence

Implementation is divided into independently reviewable, committed stages:

1. **Protocol and host capability:** shared schemas/version bump, daemon
   provider registry, generic capability/build contracts, LaTeX discovery,
   conventional-path recovery and a non-LaTeX fake-provider boundary test.
2. **Managed compilation:** generic scheduler/storage/process lifecycle plus the
   LaTeX provider's safe root/engine resolution, runner recipes, manifests, logs
   and daemon integration tests.
3. **Compile modes and source UI:** persisted on-demand/eager registrations,
   watcher recovery and coalescing, save-before-build, distinct tab controls,
   build status, same-leaf manual open, background eager open, cross-leaf
   deduplication and refresh/error handling.
4. **Owned generated-PDF viewer:** lazy local PDF.js chunk and worker, durable
   manifest-based viewer selection, view-state preservation and normal-PDF
   iframe regression coverage.
5. **Inverse search and hardening:** SyncTeX endpoint, PDF coordinate conversion,
   multi-file source reveal, real-tool acceptance matrix, documentation,
   `SPEC.md` and `CHANGELOG.md` reconciliation.

Each stage keeps the tree buildable and updates behaviour documentation in the
same commit. The feature is complete only after the real-tool acceptance path
proves compilation and inverse search on at least one macOS and one Linux-family
daemon host; a developer's single local installation is not sufficient evidence
of cross-host support.
