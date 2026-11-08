# Huddle implementation and acceptance

Status: foundation in progress, 2026-11-08. The full objective remains the
[huddle roadmap](../roadmap/huddle.md). Huddles cannot yet be created or run through
the application. No runtime capability, new session kind, API route, CLI command
or UI is advertised by this increment.

## Implemented: definition and validation foundation

- Shared format-1 document, layout, component, port, parameter and binding schemas
  live under `packages/shared/src/api/huddle/`, exported through the existing
  shared package entry point. They are local document contracts, not new wire
  messages. Application, runtime and remote protocol versions are unchanged.
- Each definition is `.puddle/huddle/<32-lowercase-hex-id>/huddle.json` in an
  explicitly selected worktree. The manifest id must match its directory. Display
  names can duplicate or change without changing identity. Creation will generate
  16 random bytes and check collisions; production creation is not implemented.
- Nodes select either `{ kind: 'builtin', component, version }` or
  `{ kind: 'local', manifest }` in their `source`. Local manifests declare `entry`
  and an explicit `dependencies` list, relative to that manifest. Input/output
  contracts and metadata are read as JSON; discovery never imports source.
- Parameter bindings are `{ kind: 'literal', value }` or
  `{ kind: 'variable', name }`. Variables and parameters declare a JSON Schema
  `schema`, `required`, optional `default`, and an `editor` hint. File/Git/session
  components declare a `worktree` parameter, and instances must bind it explicitly.
  JSON binding resolution does not grant host authority or resolve actual resources.
- The supported JSON Schema subset is type (including type arrays), enum,
  properties/required/additionalProperties, items, min/maxItems, min/maxLength and
  minimum/maximum, plus title/description. Unknown keywords fail. No remote `$ref`,
  executable expression, implicit coercion or regex execution is supported.
- `shared/src/huddle/validation/` checks component identities, duplicate ids/routes,
  port existence/types, required inputs/settings, resource variable kinds,
  reachability and cycles. Unproved port compatibility is a warning requiring
  runtime value validation; incompatible types are errors.
- Two-agent A → B → A graphs are accepted when the feedback edge declares
  `maxRounds` and a `while` condition selecting a boolean output property. Removing
  feedback edges must leave an acyclic graph. This establishes static admission,
  not execution or budget enforcement; the runtime phase must implement both.
- Prompt templates replace named paths such as `{{input.task}}`. Missing paths,
  expressions and prototype names fail; replacement text is never evaluated or
  recursively interpolated. Explicit unavailable bindings never fall back to a
  different account/session/default.
- Daemon `huddle/definitions/` discovers sibling huddles independently and captures
  source/contract snapshots with SHA-256 digests. Capture rejects traversal,
  symlinks, non-regular files, invalid UTF-8, oversize files and detected concurrent
  edits. Builtin contracts enter the digest; future runtime code must also remain
  pinned to its release. Discovery returns metadata/diagnostics, not all siblings'
  source bundles. These helpers take a worktree supplied by their caller; the
  future authorised service must validate profile/project/worktree ownership.

## Implemented: node and extension boundary

Shared `api/huddle/events.ts` defines version-1 scoped source events, extension
emissions/cursors, readout deliveries/results and trigger health. A turn-completion
resource requires its worktree, placement, runtime, segment, native conversation
and exact turn number. Extensions can supply source event ids/data/cursors but
cannot select host scope or execution identity. Delivery carries its immutable
revision, invocation and idempotency key; `unknown` remains distinct from success.
These contracts are not yet sent over application/runtime transports.

Daemon `puddlang/huddle/` now contains the inert `HuddleNode` declaration, typed
trigger/readout adapter interfaces and the node execution boundary. It supplies
immutable input/setting snapshots, validates required/unknown ports and values,
checks cancellation before work and before completion, and admits only declared
event ports through the injected emission callback. A pending unacknowledged
emission prevents node completion; late emissions after the invocation closes fail.
The callback contract requires durable acknowledgement, but the durable owner
implementation is still pending. There is no automatic repair or retry.

The executor now runs inside the isolated worker described below, where
`puddlang/huddle` is registered. It is not wired into `pudl run`; no code executes
on discovery and no application capability is advertised by these helpers.

## Implemented: private execution ledger

`runtime/huddle/state/` now owns a separate private `huddle.sqlite` under the
runtime directory. It is not the application's SQLite database. A permanent host
claim excludes concurrent ledger writers; the ledger binds the host, profile,
project, placement, huddle and runtime identities. Its initial retained format is
SQLite `user_version = 1`; an unknown newer version is rejected before write
pragmas or migrations. No application database migration or wire change is added.

Transactions commit trigger admission, execution identity and cursor together.
Stable event ids return the original execution after a lost reply; changed data
conflicts, and observing an older duplicate never rewinds the current cursor.
Admission enforces queue length and daily execution limits. Executions retain
deadlines and turn/spawn/invocation budgets, with spending committed alongside
dispatch intent. Daily limits use retained UTC date buckets. Node starts enforce
their supplied concurrency limit, defaulting to one, across the same revision/node.

Node activation identities deduplicate routing. Completion and its outgoing
ports commit in one transaction. Routing acknowledges an emission only in the
same transaction as downstream queue admission. A persistent emission watermark
rejects gaps/conflicting sequences; late duplicate observations do not route again.
The graph router described below supplies validated edges, causal iterations and
contracts; the low-level store does not itself interpret graph wiring.

External operations retain exact target/input, invocation and execution identity.
Dispatch consumption commits before the caller can send the operation. Repeating
dispatch is refused, including after close/reopen or an unknown reply. Readout or
agent observation can settle that exact outcome later without reopening dispatch.
Prepared, unconsumed operations can be cancelled; consumed operations cannot be
reset to prepared. Unresolved operations prevent node/execution completion.

The ledger reserves outcome bytes before operations and both result bytes and
completion-row capacity before node execution. Capacity failure rolls back the
entire admission, including cursor/budget changes. Logical state is capped at
64 MiB and 16,384 records including reservations; reads are capped at 256 rows
and 1 MiB per page. These are retained-payload limits, not a claim of physical
SQLite/WAL disk accounting or integration with host memory grants. Those remain
owner integration work. Retained rows are not automatically expired or pruned.

Recovery, after the caller has fenced the outgoing workers, interrupts running
executions without replaying script bodies. It cancels queued descendants and
unrouted emissions, cancels unsent operations and retains consumed operations as
unknown. Unstarted root events remain pending. Explicit cancellation also removes
an unstarted execution from pending inbox state. Late exact external outcomes
remain readable, but do not restart the interrupted graph. These methods record
intent/state; they do not themselves terminate workers or agents.

## Implemented: durable graph routing

`runtime/huddle/execution/graph.ts` interprets validated captured graph contracts
against the ledger. Starting a root execution and admitting its trigger fan-out
commit together. Output routing commits downstream join/input records, invocation
admission, budget spending and acknowledgement together; a failed destination or
capacity/budget check rolls back the entire fan-out. Repeated starts and routed
emissions are observation-only, including after close/reopen. Both source and
destination values are validated; the router rejects a completion record for an
event port and pending output from an unsuccessful invocation.

Join identity includes execution, destination node and causal activation. Ordinary
completion fan-out retains that activation. Each explicit event emission creates
a separate activation shared by its descendants; two emissions cannot contribute
one input each to a join. Required inputs must all be present. Optional inputs
received before admission are included; later optional inputs cannot modify an
already admitted invocation. A node with `activation: "any"` admits each incoming
alternative independently, validates supplied ports and does not require absent
alternatives. Downstream joins must follow those distinct causal activations.

Feedback checks the declared boolean path against each actual output, advances
to a new activation and increments the path's iteration. The initial pass is
round one; `maxRounds: 5` permits at most five passes, including the initial pass.
The count covers feedback boundaries along that causal path, so multiple different
boundaries do not reset it. Distinct feedback edges create distinct activations.
A false continuation condition exits that edge. A still-true condition at the
limit raises `HuddleFeedbackLimitError`, leaves the emission unacknowledged and
admits no next invocation; the owner scheduler must record/stop the execution as
a limit outcome. An incomplete join or failed invocation cannot be reported as
successful execution completion. Interrupt/recovery also cancels waiting joins.

These are internal routing primitives, not a running worker scheduler. They do
not launch agents or scripts, subscribe triggers, publish/activate captured
revisions, automatically settle failures, or create an owner service. The eventual
owner must supply the pinned revision and handle routing errors visibly before
this feature can be enabled.

## Implemented: captured-source node workers

`runtime/huddle/workers/` runs one local script component per Node child process.
The owner supplies a pinned Node/worker path and explicit cwd/environment; the
worker does not inherit the parent's environment by default. Transport reuses
the existing bounded runtime framing over a private inherited descriptor, not
Node's unbounded structured IPC. These helper messages belong to one pinned
runtime build; no independently negotiated huddle-owner protocol is enabled yet.

Worker jobs select one component's exact manifest, entry and declared dependency
closure from the captured revision. Preparation rechecks the revision digest and
the parsed graph against captured `huddle.json`; changes to either source or
settings reject preparation. It resolves variables/settings without reading live
source. Both sides validate the manifest against the resolved contract. The worker
loads TypeScript/JavaScript/JSON modules from its captured in-memory closure and
rejects undeclared local, absolute, file-URL and bare package imports.
`puddlang/huddle`, `puddlang`, `zod` and explicit `node:` imports are available.
`HuddleNode.contract` is relative to the component root and must match the exact
manifest before the node body runs. This is deterministic import handling for
trusted host code, not a security sandbox; Node built-ins retain the OS user's
authority.

The puddlang `Agent` client is shared with the existing single-file runner. Huddle
calls carry unique request ids, bounded operation values and scoped owner
callbacks. The parent requires a declared sessions capability and a resolved
explicit worktree before accepting agent requests; the future host bridge must
still authorise exact accounts, placements, worktrees and operations at dispatch.
No production agent bridge is connected here. Emission promises resolve only
after the owner callback acknowledges; unawaited calls/emissions prevent success.
Disconnects are not retried.

Workers have a 128 MiB V8 old-space cap, 64 pending/4,096 cumulative requests,
1 MiB combined stdout/stderr limit and an explicit deadline. These do not establish
a total RSS/child-process limit. Parent transport allocations can share the host
allowance; admission of all workers and their retained source remains owner work.
Cancellation aborts callback signals, sends termination and escalates to SIGKILL
for a CPU-bound child. Success requires both a validated result and observed
exit. Failure to confirm termination within five seconds remains a distinct
unknown outcome, with a separate exit-observation promise; it never authorises a
replacement attempt. Service-scope descendant fencing and owner-crash recovery
remain unfinished.

Archive builds include `daemon/huddle/runner.js` and `sdk.js` with their shared
chunks, using `scripts/lib/puddlang-build.mjs`. The archive smoke check loads a
captured helper, HuddleNode and zod under the archive's pinned Node without
starting a daemon or agent. Fixture builds use the same entry layout. Persistent
revision publication, scheduling, the owner service and live provider dispatch
are still needed to expose this functionality in the application.

## Bounds and defaults

Document limits: 256 nodes, 1,024 edges, 64 ports/parameters per component,
128 captured files, 256 KiB per file and 4 MiB per source bundle. Runtime JSON
values are limited to 256 KiB, depth 16 and 8,192 visited values. Discovery scans
at most 4,096 directory entries and accepts at most 512 huddle ids per worktree.
Graph diagnostics are bounded; source discovery reports a malformed sibling
without hiding healthy definitions.

Execution settings already have validated defaults: one concurrent execution,
50 turns, eight cumulative agent spawns, one hour, 128 queued events, 100 daily
executions, 32 daily spawns and 512 invocations per execution. Queuing defaults to
`queue`, cleanup to `stop-owned`. The ledger enforces admission, deadline,
concurrency and cumulative turn/spawn/invocation bounds. The router enforces
feedback rounds. Coalescing/drop policies, actual dispatch and lifecycle cleanup still need the
scheduler/control layer. Blank graphs can be saved as documents but fail
activation validation until a trigger exists.

## Automated evidence

The foundation's targeted suite covers document/schema/value limits, bounded
feedback versus unbounded cycles, worktree declarations and resource-variable
types, literal/default resolution, prompt interpolation, duplicate identities,
source digests, concurrent edits, multiple sibling huddles, unsupported formats,
missing components, symlink/path escapes and data-only inspection of source that
would throw if imported.

Run from the repository root with the installed dependencies:

```sh
node node_modules/vitest/vitest.mjs run packages/shared/test/huddle packages/daemon/test/huddle
node node_modules/typescript/bin/tsc -b packages/shared packages/daemon
node node_modules/eslint/bin/eslint.js packages/shared/src/api/huddle packages/shared/src/huddle packages/shared/test/huddle packages/shared/test/helpers/huddle.ts packages/daemon/src/huddle packages/daemon/src/puddlang/huddle packages/daemon/test/huddle
node node_modules/eslint/bin/eslint.js packages/shared/src/runtime/huddle packages/daemon/src/runtime/huddle packages/daemon/test/helpers/huddle
node node_modules/vitest/vitest.mjs run packages/daemon/test/huddle/workers packages/daemon/test/puddlang
```

Verified 2026-11-08: the expanded shared-package plus huddle-definition run passed
171 tests in 21 files. Shared/daemon TypeScript builds and the scoped ESLint check
passed. The roadmap's JSON example parses with the implemented definition schema.
The subsequent node/event increment passed 32 huddle tests across six files,
shared/daemon TypeScript builds and its scoped ESLint check. Tests include exact
turn identity, forged extension scope rejection, unknown delivery, invalid node
ports/settings/approval, immutable inputs, unacknowledged/late emissions and
cancellation. Test fixtures
live in `shared/test/helpers/huddle.ts` and are not installed components.
The ledger increment passed the expanded shared/huddle suite: **197 tests in
27 files**, including **17 new ledger tests**. Shared/daemon TypeScript and scoped
ESLint passed. Tests cover cursor/queue rollback, duplicate/conflicting events,
writer exclusion and identity, daily/cumulative/concurrency limits, byte-bounded
pagination, reserved outcomes under pressure, atomic completion/routing rollback,
cancelled/unknown operation distinctions and late outcomes after interruption.
An isolated subprocess recorded dispatch, wrote one test file and killed itself
with SIGKILL. Reopening retained consumption; recovery refused redispatch and the
file still contained exactly one write. A separate check rejected a newer ledger
version without changing its database bytes. These checks establish ledger
durability, not complete runtime/service/provider continuity. There are no
operational huddle commands or application migrations yet.

The routing increment passed **211 tests across 30 files** in the expanded
shared/huddle suite, plus shared/daemon TypeScript and scoped ESLint. Its fake
coder/reviewer graph completes three rounds across repeated ledger reopen, exits
on approval and refuses further admission after a configured round limit.
Interleaved root events and explicit event emissions retain separate join inputs;
partial joins survive reopen; repeated delivery does not add invocations; budget
exhaustion and invalid destinations roll back fan-out and acknowledgement together.
Further checks cover alternatives, late optional inputs, forged emission kinds,
failed branches and cancellation of incomplete joins. This is no evidence of
provider-native turn completion or daemon-replacement continuity.

Worker verification uses real child processes with bundled runtime helpers. It
covers captured local imports, wrong manifests/wrappers, undeclared imports,
runtime port checks, acknowledged emissions, correlated fake agent requests,
missing worktree/capability refusal, unawaited calls, deadlines, cancellation,
runaway logging and child crashes. A graph/ledger integration fixture captures a
multi-file component, changes its worktree source, then executes the original
captured bytes and retains one downstream result across ledger reopen. The
archive-layout smoke runs in this fixture suite. The expanded shared, huddle,
puddlang and runtime framing/encoding/decoding suite passed **279 tests in 38
files**, with shared/daemon TypeScript and scoped ESLint passing. Additional
worker checks cover a positively failed spawn and observe entry into the busy
script before deadline termination. A full isolated `build-tarball.mjs --stage-only`
build on macOS arm64 passed executable metadata, the existing puddlang smoke and
the new multi-file worker smoke under pinned Node **22.21.1**. This is staged
archive evidence; no archive was published or installed, no daemon service was
started, and native supervision remains unverified. Existing puddlang
tests also cover the shared client extraction. A stale schema-39 migration fixture
was corrected to remove the later window-arrangement column before replaying
migrations.

## Remaining implementation and acceptance

Phase 0 remains open for the full component contract catalogue and lifecycle
admission. Phase 1 has the private ledger and graph routing; next wire them into
the independent huddle owner, worker scheduler and exact-operation bridge,
including host resource accounting and lifecycle fencing. Runtime capability
admission; third
session kind and application protocol transition; IDE and normal windows; actual
trigger/readout adapters; wrapped puddlang execution and lifecycle nodes; authoring
tools, docs/skill and packaged integration.

All live provider, SSH, native window, supervisor, complete owner crash/reboot, trigger cadence,
readout reconciliation, permission/takeover, persistence/retention and installation
acceptance is **Pending**. No fake fixture, static validator or TypeScript build
establishes those behaviours. Maintain the roadmap's complete acceptance list as
these features ship; do not reduce the goal to this preparatory layer.
