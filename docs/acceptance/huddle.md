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

The executor is intended for an isolated worker. It is not wired into `pudl run`
or registered as the `puddlang/huddle` import yet; no code executes on discovery,
and no capability is advertised based on these internal helpers. The worker must
also match the module's contract path to the exact captured manifest and bind
operations to the authorised owner before invoking it.

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
`queue`, cleanup to `stop-owned`. These are document contracts only until the
owner scheduler enforces them. Blank graphs can be saved as documents but fail
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
There are no database migrations or operational commands in this increment.

## Remaining implementation and acceptance

Phase 0 remains open for the full component contract catalogue and lifecycle
admission. Then implement the independent huddle owner, durable
inbox/outbox and exact-operation bridge; runtime capability admission; third
session kind and application protocol transition; IDE and normal windows; actual
trigger/readout adapters; wrapped puddlang execution and lifecycle nodes; authoring
tools, docs/skill and packaged integration.

All live provider, SSH, native window, supervisor, crash/reboot, trigger cadence,
readout reconciliation, permission/takeover, persistence/retention and installation
acceptance is **Pending**. No fake fixture, static validator or TypeScript build
establishes those behaviours. Maintain the roadmap's complete acceptance list as
these features ship; do not reduce the goal to this preparatory layer.
