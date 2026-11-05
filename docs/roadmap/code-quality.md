# Code quality review

Reviewed 2026-11-05 against the working tree based on `1cd3b38`.

## Assessment

There are worthwhile, bounded improvements. The strongest are unnecessary retention
of streamed CLI logs, repeated serialization in notebook execution, and duplicate
Git discovery work. Some smaller duplication has already produced inconsistent UI
behavior. None of these findings justifies a broad architectural rewrite.

This report records recommendations, not implemented fixes. Three subagents reviewed
the web UI, daemon, and CLI/desktop/remote packages. The primary reviewer inspected
shared code and build tooling and checked the retained findings against their source
and callers. Existing unrelated working-tree changes were left intact.

The review is a broad, targeted source review, not an exhaustive audit of every line,
a security audit, or a performance benchmark. File size, explicit schemas, defensive
checks, and personal formatting preferences were not sufficient reasons to report
an issue. References below use repository-relative paths and review-time line numbers.

| Priority | Finding                                                      | Benefit                                               | Scope/risk                                              |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| High     | 1. CLI follow mode retains all streamed output               | Bound memory during long-running log follows          | Small transport API change; preserve capture defaults   |
| Medium   | 2. Notebook publishing serializes unchanged cells repeatedly | Remove quadratic transition work                      | Careful cross-cell output tracking required             |
| Medium   | 3. Repository discovery scans the owner twice                | Avoid repeated Git subprocesses and filesystem probes | Small discovery change                                  |
| Medium   | 4. Session action eligibility is duplicated and inconsistent | Consistent resume availability                        | Small shared policy; keep surface-specific presentation |
| Low      | 5. Worktree downloads duplicate an existing helper           | One object-URL cleanup policy                         | Small reuse change                                      |
| Low      | 6. Tab strips repeatedly search already-indexed session data | Simpler lookup code and less repeated work            | Local rendering change                                  |
| Low      | 7. Archive checksums allocate the entire archive             | Bound checksum memory                                 | Build-tool helper only                                  |

Priority expresses relative value within this cleanup backlog, not incident severity.
No measured latency, memory-exhaustion incident, or browser download failure is
claimed where the evidence establishes only unnecessary work or divergent behavior.

## Findings

### 1. Separate streaming from output capture in CLI transports

**Evidence:** `packages/cli/src/lib/logs.ts:20–45` passes `onStdout` to transport
execution for `tail -f` and `journalctl -f`. Both
`packages/cli/src/lib/transport/local.ts:12–39` and
`packages/cli/src/lib/transport/ssh.ts:171–201` append every stdout chunk to a string
and also invoke that callback. `ExecOptions` in
`packages/cli/src/lib/transport/transport.ts:13–20` has no way to disable capture.

The log consumer writes those chunks immediately and does not need the accumulated
stdout. For a follow command, completion may be arbitrarily far away, so retained
output grows with the entire follow session. This is directly visible in the data
flow; a heap benchmark is not needed to establish unbounded retention.

**Recommendation:** Add an explicit capture policy and opt log streaming out of full
stdout retention. Keep existing capture behavior by default: installer progress and
other callers may need both callbacks and the final result. Retain bounded stderr
diagnostics for the streaming case. The nearly identical child-output collection,
timer cleanup, and result construction in local and SSH execution are a reasonable
small shared helper seam; keep spawning, SSH quoting, and SSH environment selection
in their respective transports. Count this as one fix, not two independent refactors.

**Validation:** Exercise a finite, high-volume child command through both transport
implementations, asserting full callback delivery and no accumulated stdout when
capture is disabled. Verify default capture, stdin, nonzero exit, spawn error, and
timeout semantics remain intact. Use the existing fake SSH fixture at
`packages/cli/test/helpers/fake-ssh.mjs`; no daemon launch is needed.

### 2. Publish changed notebook cells without serializing the whole notebook

**Evidence:** `packages/daemon/src/notebooks/cell-bridge.ts:19–31` loops over every
cell and JSON-encodes its source, state, execution count, and outputs on every
`LiveClient.publish()`. Encoded-string comparison suppresses duplicate events only
after serialization. The execution loop calls publish before and after each cell
(`:78–91`), and message handling also schedules flushes at 100 ms (`:33–39`).
`packages/shared/src/api/notebooks/notebook-execution.ts:9` permits 2,000 cells.

A successful N-cell execution therefore performs at least 2N² cell serializations
from state transitions alone, plus output flushes. Completed cells' potentially
large outputs are repeatedly encoded. An isolated subagent experiment executing the
actual extracted `LiveClient` class with a stub base/kernel counted 20,000
`json.dumps` calls and 299 emitted events for 100 cells with running/succeeded
transitions. This is an operation count, not a timing benchmark or real-kernel test.

**Recommendation:** Publish the initial queued cells once, then track which cell
records may have changed and serialize only those. State changes, cancellation of
remaining cells, output changes, and elapsed-time updates must mark their cells.
Retain batching and value deduplication where useful.

**Important constraint:** nbclient can update earlier cells through shared display
IDs. Tracking only the currently executing cell would be incorrect. Establish all
affected cells for `update_display_data`, clear-output handling, and other cross-cell
mutations before narrowing publication. A conservative full scan for uncommon
cross-cell operations can be preferable to a fragile optimization.

**Validation:** Extend
`packages/daemon/test/notebooks/notebook-execution.test.ts` with a serialization/work
count and a cross-cell display-ID regression. Preserve its streaming, input,
failure/cancellation, and clear-output cases. Keep widget coverage in
`packages/daemon/test/notebooks/notebook-widgets.test.ts`; widget display coverage
alone does not prove ordinary cross-cell execution updates are preserved.

### 3. Let the repository discovery queue scan the owning repository once

**Evidence:** `packages/daemon/src/worktrees/repositories.ts:172–200` seeds the owner
into `roots`, calls `nestedGitRoots(owner, visible)` in the initial scan, and then
queues that same owner and calls `nestedGitRoots` again. The helper (`:112–143`)
runs Git status and canonicalizes/stats candidate paths, including Git root probes.
Initial scan results are additionally root-checked at `:180`.

The `processed` set prevents repeated queue processing but does not cover the initial
scan. This duplicates work on the ordinary owning-repository path, including when
there are no nested repositories. `useGitRepositories` in
`packages/web/src/lib/queries/worktree-queries.ts:157–171` refreshes enabled queries
on a focus-aware ten-second interval, so this is recurring work.

**Recommendation:** When an owner exists, seed it and let the existing expansion
queue discover its nested repositories. Keep the filesystem scan for directories
with no Git owner. Preserve submodule enrichment, canonical root deduplication,
visible-root filtering, and deterministic result ordering. No broader cache or
change to Git locking is needed for this simplification.

**Validation:** Retain the real repository fixtures in
`packages/daemon/test/worktrees/repositories.test.ts`, including ignored nested
repositories and initialized/uninitialized submodules. Add a command-count check
for one nested-root scan per processed repository, and explicitly cover a visible
directory with no owner containing multiple repositories. No latency improvement
has been measured in this review.

### 4. Share session lifecycle eligibility across mobile and desktop

**Evidence:** `packages/web/src/features/mobile/SessionActions.tsx:46–47,98–110`
derives live/archived status locally and offers Resume for every non-live,
non-archived session, disabling it only for disconnection or a pending action.
Desktop `features/workspace/sessions/SessionActions.tsx:202,458` excludes missing
native conversations and worktrees. `SessionTabActions.tsx:26–30,38` also handles
those missing-resource reasons, while `panes/PaneSessionOverlay.tsx:27–28` repeats
the same prerequisites.

The duplication has an observable consequence: mobile offers an action the desktop
already knows is unavailable. This finding concerns UI policy drift, not a claim
that the mobile endpoint bypasses daemon validation.

**Recommendation:** Extract a small pure session-lifecycle policy helper returning
live/archived status and resume eligibility with an unavailable reason. Consume it
from these surfaces. Keep connection/pending state, navigation, remote capability
restrictions, and presentation with each caller. Importing the entire desktop menu
hook into mobile would introduce unrelated account/settings queries and behavior.

**Validation:** Cover all session statuses, each missing-resource flag, and live
sessions whose Stop action must remain available. Add a mobile interaction check
showing the appropriate unavailable state, and confirm desktop menu, tab shortcut,
and overlay agree. The mobile E2E area is `packages/web/e2e/mobile.test.ts`; existing
session-order/selection unit tests do not establish action-policy coverage.

### 5. Reuse the blob-download helper for worktree downloads

**Evidence:** `packages/web/src/lib/queries/worktree-queries.ts:455–475` creates an
object URL and temporary anchor, clicks it, removes the anchor, and immediately
revokes the URL. `packages/web/src/lib/download-blob.ts:2–15` already owns the same
operation and delays URL revocation so the browser can consume the download.
`PhoneFileRow.tsx` and notebook output already use that helper.

There are two implementations of the same browser side effect with different
cleanup timing. The helper also puts anchor removal in `finally`, while the
worktree implementation removes it only after a successful click. No specific
browser failure was reproduced here.

**Recommendation:** Keep fetching and Content-Disposition filename parsing in
`downloadPath`, then pass the blob and filename to `downloadBlob`. Review URL
lifetime in that one helper if the delay policy changes later. Preview object URLs
have different lifetimes and should not be folded into a download helper.

**Validation:** Preserve filename tests in
`packages/web/test/lib/queries/worktree-queries.test.ts`. That file explicitly does
not exercise the DOM download side effect. Verify one browser download, filename,
anchor cleanup, and eventual revocation through the shared helper.

### 6. Use one session lookup per tab instead of repeated array searches

**Evidence:** `packages/web/src/features/workspace/panes/PaneTabStrip.tsx:98–100`
already builds maps for session branches and directories. Its tab render then uses
`sessions.find` separately for terminal session, file session, and file directory
(`:154–174`). An ordinary editor tab can search the same session list twice.

For T tabs and S sessions, this session-resolution portion performs O(T × S)
search work despite already doing O(S) indexing. This is a small local cleanup;
there is no evidence here that it is a dominant rendering bottleneck.

**Recommendation:** Build a session-by-ID map once per render and resolve each
tab's session once. Reuse the existing directory map where appropriate. Keep the
branch/directory interfaces required by `editorTabLabel`; do not redesign that
helper solely to eliminate a small map. Memoization is optional and should follow
actual input identity/profiling needs, not be added automatically.

**Validation:** Check terminal tabs, external-root files, nil-session untitled
drafts, and references to missing sessions. Preserve tooltip and file-directory
behavior. Relevant existing coverage includes
`packages/web/test/workspace/panes/pane-interaction.test.ts` and
`packages/web/test/editor/tabs/editor-tabs.test.ts`; a focused rendering regression
is needed if those tests do not exercise the resolved props.

### 7. Stream archive checksums instead of reading whole archives into memory

**Evidence:** `scripts/build-tarball.mjs:282`,
`scripts/build-cli-tarball.mjs:82`, and `scripts/lib/node-runtime.mjs:45` each compute
SHA-256 with `createHash(...).update(readFileSync(archive))`. These are compressed
distributions containing Node and, for the host archive, bundled/native code.
The downloaded Node archive is streamed to disk and then read back in full solely
for hashing.

Each checksum unnecessarily requires a buffer proportional to archive size.
The scripts are short-lived and sequential, so this is lower priority than the
unbounded CLI log capture. No CI out-of-memory failure is asserted.

**Recommendation:** Use a small build-tool file-hashing helper that updates the
hash from a read stream. Share it across the three sites. Preserve exact checksum
file formatting, checksum verification before extraction, and failure propagation.
Do not turn this into a general build-system rewrite.

**Validation:** Compare streaming digests to the current implementation for empty,
small, and multi-chunk files, and confirm missing/read-error cases fail. On the next
packaging change, run the existing archive smoke checks and checksum verification.

## Review coverage and deliberate non-findings

- **Web:** Reviewed session actions, pane/tab composition, editor/notebook and
  preview paths, file downloads, query code, and representative related tests.
  The recommendations preserve HUMANS.md's visual intent. No visual redesign or
  blanket component splitting is proposed.
- **Daemon:** Reviewed repository discovery and Git operations, notebook execution,
  and sampled runtime/session, update/recovery, and execution boundaries. Repeated
  authority, identity, claim, and post-await checks are not interchangeable checks:
  they often establish fresh evidence after state can change. Preserve them.
- **Client and remote:** Reviewed local/SSH execution, logs, lifecycle/installation
  helpers, desktop composition, connector routing, remote service, and encrypted
  transport. The specific retained transport issue is documented above; absence of
  further findings is not a security certification.
- **Shared and tooling:** Reviewed representative API schemas, notification title
  and abbreviation helpers, widget-state merging, private-file/ledger utilities,
  release lookup/source selection, archive builders, installer staging, CI install
  setup, and build/workflow composition. Explicit wire shapes and schema-derived
  types are useful, not accidental verbosity. Release lookup already bounds its
  body and timeout. Shared Node staging and release-note extraction already avoid
  duplicating their core behavior.

In particular, do not simplify atomic private-file writing to an unguarded
write/rename sequence: exclusive creation, fsync, original-error preservation, and
cleanup ownership have distinct purposes. Do not merge the public API and private
host-control authority paths merely because their request plumbing resembles each
other. Do not replace immutable runtime/placement identities with a convenient
mutable “current session” lookup. Keep browser production builds separate from
development gateway dependencies and Electron preload format requirements.

There is no recommendation to delete compatibility code without proving its
supported-version callers are gone, change protocol schemas for cosmetic reasons,
or split every module exceeding a line threshold. Those changes would add churn
without an established benefit from this review.

## Suggested implementation order and verification limits

1. Fix log capture with explicit transport semantics and targeted tests.
2. Remove duplicate repository discovery and share lifecycle eligibility; these
   have narrow seams and directly demonstrable benefits.
3. Optimize notebook publication after adding cross-cell output coverage.
4. Fold download-helper reuse and tab lookups into small local changes. Stream
   archive hashes when next touching packaging, or as an independent small patch.

Only this report was written for the review. No application code was refactored,
no daemon was launched, and no full test/build suite was run. Findings were checked
by source/caller inspection; the notebook experiment counted work in isolation.
Tests named above are proposed validation for future changes, not claims of passing
test runs. Native service lifecycle, SSH deployments, browser behavior, and actual
runtime performance remain outside what this documentation change proves.
