# Huddle — visual orchestration powered by puddlang

Status: implementation in progress, 2026-11-08, following the user's instruction
to implement this roadmap. Phase 0 has shared document contracts, graph/binding
validation, data-only source discovery/capture, event/delivery contracts and an
internal node execution boundary. Phase 1 has the private execution ledger and
durable graph routing with correlated joins and bounded feedback, plus isolated
captured-source script workers, retained revisions/activation and a manual scheduler
in an independent owner process with private authenticated control, explicit
runtime-role metadata and pinned capability checks. Phase 2 has the third session
kind, immutable application placement and common runtime inventory role, with
application protocol 28.11. Local/SSH inactive creation, discovery, inspection and
placement opening now have sidebar creation and a graph pane with manifest
editing, shared source/layout drafts, settings, undo and file-conflict review.
Pointer/touch and keyboard node movement, position settings, pan and fit controls
and direct socket connections are implemented. Graph camera, node/edge selection
and graph/list mode now use scoped private view persistence through browser reload,
same-window tab moves and desktop recovery/transfer snapshots. Viewport culling now
preserves crossing wires, selection, focus and gestures, with a measured 256-node/
1,024-edge browser fixture. The IDE now exposes saved-source
Start/Apply, manual Run, Interrupt/Resume/Stop and live execution history. Daemon
adoption/projection now observes independent huddle owners alongside ordinary
runtimes, including across isolated daemon replacement. Pinned production launch
and exact-owner controls now integrate with session kill/archive. Local/SSH APIs
now admit saved-source Start/Apply, reviewed Rearm/Run/Interrupt/Stop and bounded
live-owner history. Native supervision and the initial provider lifecycle nodes are implemented; broader native/provider acceptance remains open. Selected-daemon startup checks retained huddle contracts read-only
before service mutations, while allowing compatible controllers to inspect
interrupted owners. Offline host removal, purge fencing and release
collection now recognise huddle ownership and clean shutdown evidence. Host-update preflight, shutdown
checkpoints and fresh adoption/recovery now preserve huddle contracts alongside
ordinary owners.
Revision-checked single-file source saves now reject detected concurrent edits;
the graph UI currently shares ordinary editor conditional file saves. Application
28.11 adds exact captured-source reads and text-preserving digest-checked saves,
with CLI/MCP support and response verification. Full-capture digest integration
with IDE drafts/conflicts/window recovery and retained graph view state are now
implemented.
Internal queued Apply/Arm/Run/Interrupt now require the inspected owner and
activation, preventing stale views from dispatching against a replacement.
Bounded live-owner history reads validate execution/node/operation records;
application 28.2 exposes explicit public projections. Application 28.12 adds recorded-owner discovery and retained execution/result history
without connecting or restarting an owner. Application 28.13 adds recorded activation and historical source inspection without
a connected owner, with exact saved comparisons through CLI/MCP. Application 28.10 now exposes exact active
revision/source/binding inspection and saved-versus-active comparison through the
IDE, CLI and MCP. Retained inspection works after project source deletion while
the owner remains connected. Host-side exact agent-turn admission now shares
the ordinary dispatcher, with schema-45 huddle caller identities and owner receipt
retention. The private owner mailbox now connects script attach/ask calls to
durable intent, single-consumption claims and exact-result settlement, with an
optional runtime capability. Production daemon dispatch and Start/Apply now admit
declared session bindings and attach/ask scripts on operation-capability-2 owners.
Migration 46 retains exact cancellation intent. Editable Prompt agent and Review
agent templates now materialise project-local source, with worktree/session selectors,
prompt substitution and bounded feedback settings. An isolated two-agent test verifies
reply exchange and approval exit. Migration 48 now records huddle spawn placement
and exact runtime consumption through the existing session/launcher transactions;
undispatched spawns are excluded from automatic boot resume. Migration 49 and the
host spawn service now retain exact readiness outcomes and consume one guarded
cleanup attempt. The owner-local spawn outbox now retains single-consumption claims
and returns execution-scoped handles after durable readiness settlement; isolated
node/agent workers verify spawn-to-ask composition. The independent owner now
serves private spawn messages behind the optional `spawns: 1` capability, with reconnect
and interruption checks. Production dispatch now scans both operation queues,
observes retained creation across controller replacement and drives the subsequent
agent prompt. Start/Apply now resolve and recheck explicit account/provider/project
resources alongside registered worktrees, rejecting unsupported owners. Durable
owned-agent cleanup now handles Interrupt/Stop and failed/deadline executions,
retains pending cleanup across controller loss and waits for exact exit before Stop
completes. Each execution captures its cleanup policy; explicit `retain-owned` leaves
its agents running. Application 28.8 adds the editable Spawn agent template and
project/worktree/provider/account selectors. Runtime metadata now advertises
`spawns: 1`; older owners remain supported but cannot run spawn graphs. The template
returns its initial prompt reply and an execution-scoped handle. Application 28.9
adds Prompt spawned agent and Review spawned agent templates. Their explicit
execution-scoped inputs retain each handle across feedback rounds; two isolated
agents now complete a spawn-once review loop through these shipped templates.
Resume/restart templates now use ordinary SessionService lifecycle controls with
durable operation/launch attribution (application 28.14, runtime lifecycle-1).
Native-provider acceptance remains pending.
Application 28.25 adds the initial editable flow-node catalogue: Transform,
Format text, Condition, Merge and Join, using existing graph routing and worker
contracts. The IDE and authoring kit share source and a complete branching/join
example. Bounded feedback remains an explicit graph-edge policy.
Application 28.26 adds explicit copying from New huddle and CLI/MCP, preserving
bounded saved source/layout/docs/fixtures under a fresh random id with a stopped
placement. Reviewed source and capability checks precede publication; original
owners and private state are untouched.
Application 28.27 adds the initial creation starters: Manual flow and Two-agent
review, sharing editable node sources, layout/docs/input fixtures with the authoring
kit. The review starter requires explicit agent selection and uses existing bounded
feedback and provider dispatch; creation remains inactive.
The [usage guide](../huddle.md) describes the implemented slice.
Phase 4 now has runtime-owned interval, one-off date/time and daily/selected-weekday
calendar triggers, durable occurrence admission, coalesce/skip/bounded catch-up,
explicit timezone/DST semantics and capability gating. Calendar lookback is bounded
to 366 days. Filetree now observes bounded regular-file snapshots with worktree
bindings, globs, output exclusions, debounce and durable batches without a controller.
Git now observes worktree HEAD and shared repository refs with durable net-change
batches, common-directory deduplication and capability gating.
Migration 47 adds bounded, transactionally captured host session lifecycle/status
observations and typed retention gaps. Optional `sessionEvents: 1` now delivers these
observations into independent owners with durable source cursors, maintenance/reconnect
fencing and Session lifecycle editor settings. Runtime protocol 1.2 now supplies a
separate bounded native-turn stream for hook-based interactive and headless controls, retaining
exact outcomes and originating ask/huddle identities across controller disconnection.
Headless observations use exact command-correlated keys, successful native results
plus exit evidence, and immutable ask attribution. Interactive Codex now retains
exact native turn ids, including external turns and events preceding RPC replies,
with ordered in-process identity delivery. The Turn completed node is now available
in the editor with explicit worktree/live-agent settings. Automatic delivery feeds
completion nodes from durable source cursors, with bounded active polling,
maintenance fencing and reconnect catch-up. An internal completion subscription ledger pins exact targets,
validates contiguous durable native pages and atomically admits external completions
with their cursors. Optional `completionEvents: 1` now connects the ledger to private
owner lifecycle/delivery controls and captured script execution. Automated/unknown
completions are suppressed. Optional `completionPlans: 1` now supports read-only
retained/proposed activation plans and host capture of exact durable agent baselines
after queued review. Application 28.20 adds opt-in same-execution native confirmation through
`agent.askNative()` and a declared completion-trigger parameter. Native prompt/review
templates keep the same execution and feedback/turn/time budgets, require matching
ask and native evidence, and never emit an additional automated root. Real-provider
native feedback acceptance remains open.
Project-local HuddleTrigger adapters now run in bounded independent subscription
workers with atomic event/cursor admission, explicit resume policy and source-local
health. Their subscriptions survive frontend/controller disconnection, and the IDE
shows custom-source gaps. Application 28.17 adds a unified read-only trigger health
and accepted-backlog inspector in the IDE and CLI/MCP, including retained timer
coalescing/skipping and date disposition. Application 28.28 and runtime calendar-2
add monthly/yearly selection by month and day, skipping missing dates with a
bounded month search that handles non-leap centuries. Daily/weekday calendars
retain their existing contracts. Local readouts now execute
captured HuddleReadout adapters with durable intent, bounded receipts and explicit
unknown outcomes. Explicit owner/API observation and the history panel's Check
delivery action now reconcile uncertain deliveries through their captured adapters,
without resending or continuing ended graphs. Application 28.21 adds readout observation from cleanly stopped retained owners,
reusing captured adapters and the original ledger without restarting a graph.
Application 28.22 adds an editable Write report readout with explicit worktree,
relative path, text/JSON formatting and content-based delivery observation. It
creates complete files without overwriting conflicts; the authoring kit includes
the same source. Filetree output exclusions remain explicit.
Interrupted owners still require recovery first. Same-boot recovery on
macOS launchd lifetimes is implemented in application 28.24 using kernel resource
coalitions; detached host-session lifetimes retain reboot-only recovery. Explicit reboot recovery
now restores the recorded activation, queued work and trigger cursors in one
replacement owner (application 28.15, runtime recovery-1, migration 51). Running
scripts are interrupted and historical agent operations remain observation-only.
The IDE and CLI/MCP expose this action. Application 28.16 adds a per-run auto-start
switch and a paginated host-startup pass through the same recovery launcher. Only
armed, opted-in predecessors from an earlier boot are recovered. Native reboot
acceptance remains pending. Application 28.18 adds explicit same-boot recovery
for systemd/cgroup-v2 owners with retained containment and positive empty-scope
evidence. Application 28.19 adds bounded automatic recovery from existing owner-loss
reconciliation for armed supporting Linux runs, with Stop/archive/maintenance gates
and a retained three-replacement limit. Application 28.24 adds macOS launchd coalition fencing and verified native
crash/queued-work recovery on macOS 26.5.2 arm64. Detached host-session recovery and
broader native/platform acceptance remain pending.
See [implementation evidence](../acceptance/huddle.md). Unshipped
API names and examples below remain proposals except where explicitly documented
in acceptance as implemented.

The user explicitly permits breaking puddlang changes during this work; its
current script API is not fixed. Prefer a coherent huddle execution model over
preserving an unused puddlang interface. Keep existing agent/terminal runtime
compatibility and document any changed puddlang commands/contracts.

A huddle is a third Puddle session kind alongside agents and terminals. It opens
a node-based IDE for building, inspecting and running an orchestration graph.
Triggers bring events into the graph, puddlang nodes do work, and readouts carry
results to other nodes or external services. Each live huddle has its own
independent runtime, so closing a view or replacing the daemon does not destroy
its orchestration state or subscriptions.

Read [HUMANS.md](../../HUMANS.md) before UI work; it is the controlling design
brief. Read [SPEC.md](../../SPEC.md), the [puddlang usage guide](../puddlang.md),
its [roadmap](puddlang.md) and [acceptance checklist](../acceptance/puddlang.md)
before changing execution. Some older roadmap sketches predate the implemented
puddlang slice; use current code and the usage guide for existing behaviour.

**Implementation agents must create and maintain `docs/acceptance/huddle.md`.**
Record what actually shipped, concrete contracts and storage decisions, migrations,
commands, tested versions, automated results, manual evidence and outstanding
limitations there after every phase. Keep this roadmap's phase status accurate.
Update SPEC, protocol documentation, CLAUDE and the rolling changelog when their
implemented surfaces change. Do not present a planned check as a passed check.

## 1. Product shape and first useful workflows

The right session sidebar gains a **New huddle** action in its existing creation
tray, beside New agent and New terminal. Use the existing Puddle glyph for that
action and for huddle session rows/tabs. Include the collapsed rail and project
context menus, with the same search, ordering, selection and archive behaviour.
Individual nodes may have custom colours and icons; the huddle's session-kind
identity remains the Puddle mark.

Creating a huddle selects a project and a definition worktree, then opens its IDE
with a blank graph or an explicit template. Creation saves an inactive definition;
it does not arm external triggers or send an agent prompt. Existing definitions
can be opened without creating another runtime. Start arms a saved revision;
Run supplies one manual trigger event to the active revision. For a stopped
huddle, offer an explicit Start and run action showing the revision and bindings.
This is now implemented on hosts with revision review (28.10+): the IDE validates
both inputs, starts once, confirms the active revision/variables, then sends one
manual event to that exact activation. Automatic triggers arm during Start; any
uncertain step requires inspection without retries or rollback.

Initial workflows should prove the whole model:

1. **Implement, review, revise:** manual input starts an implementer; its completed
   turn feeds a reviewer; structured feedback feeds the implementer until approval
   or a visible round limit. Agents share a selected worktree when they need to
   inspect the same uncommitted files.
2. **React to files:** a debounced change in a declared worktree feeds a script,
   then a result/readout. Outputs and huddle configuration are excluded from the
   watch by default to avoid a self-triggering loop.
3. **Review repository changes:** a new commit or tag feeds an agent with exact
   Git identities, then records a report in a declared worktree.
4. **Scheduled work:** a host schedule feeds a bounded workflow even when no
   frontend is open. Missed occurrences and timezone rules are explicit.
5. **Two agents exchanging replies:** two selected agents feed each other after
   exact turn completion, with one seed event, a shared conversation correlation
   id, a stop condition and finite budgets. No coordinator agent is required.

The user-provided node-editor images establish the interaction model: spatial
nodes, labelled sockets, visible directional connections and configurable inputs.
Mac Shortcuts supplies the approachable action-library/settings model. Translate
these ideas into Puddle's visual language; do not reproduce the references' heavy
grid, bevelled boxes, thick borders or glossy headers.

## 2. Existing foundations and concrete gaps

Implementation priority: finish working features, reusing existing checks rather
than expanding preparatory test infrastructure. Puddle's session lifecycle service
and status/turn observations already drive its UI and notifications. Huddle nodes
must call those existing controls and consume those observations; do not introduce
another agent lifecycle manager or provider-status detector. Huddle owns graph
routing, durable subscriptions/cursors and execution policy. Resume/restart nodes
should extend the existing operation bridge to the ordinary session controls.

| Area | Existing code to reuse | Required extension |
| --- | --- | --- |
| Session identity | `shared/src/api/agents/sessions.ts`, daemon `db/stores/sessions.ts`, `db/stores/huddle/placements.ts` and `sessions/` | Migration 43 and application 27.0 add huddle placement identity without an account, native conversation or PTY. Inactive creation/opening is exposed in application 27.1; application 28.2 adds manual lifecycle/history APIs. The IDE now exposes these controls. A kind-aware audit corrected CLI labels, tab tooltips and unavailable-project draft recovery. Missing-placement draft recovery and close review are now implemented too; remaining integration checks are still open. |
| Sidebar and actions | Web `features/workspace/sessions/SessionSidebar.tsx`, `sidebar/`, `SessionActions.tsx`, `lifecycle.ts`, `session-selection.ts` | Add creation, glyph, opening and lifecycle policy to expanded/collapsed presentations and bulk actions. Current callbacks and rows assume ordinary sessions. |
| Puddlang | Daemon `puddlang/service.ts`, `operations.ts`, `runner.ts`, `runtime-api.ts`, `outcomes/`; shared `api/agents/puddlang*.ts` | Reuse provider-neutral spawn/attach/ask/stop and exact turn handling. Current programmes are daemon-owned child processes and become interrupted on daemon replacement. No graph, durable scheduler or plug-in API exists. |
| Independent ownership | Daemon `runtime/ownership/`, `transport/`, `lifecycle/`, `resources/`, `controller/`, `execution/turns.ts`; shared `runtime/` | Add a huddle owner role with retained graph state and triggers. Existing terminal snapshots, native-conversation segments and agent launch seeds cannot stand in for a huddle. |
| Compatibility and maintenance | Shared `node/installation/capabilities.ts`; daemon `host/`, `updates/preflight/`, `updates/verification/` | Advertise huddle support in installed and live runtime metadata; include huddle owners in adoption, update checkpoints, resource accounting and removal. |
| Files and Git | Daemon `worktrees/`; `compilation/dependency-observer.ts` and `dependency-watcher.ts` | Reuse canonical directory resolution, Git mutexes and bounded observation techniques. Compilation's daemon-owned watcher is not a durable trigger service and should not own huddle subscriptions. |
| Tabs and windows | Shared `api/workspace/ui-state.ts`, `desktop/windows/`; web `workspace/layout/`, `panes/`, `tabs/`, `windows/`; desktop `src/windows/` | `TabRef` currently supports editor and terminal variants. Add huddle content through layout, persistence, drag, transfer, docking, restoration and recovery. |
| Visual controls | Web `components/puddle-glyph.tsx`, `colour-picker.tsx`, `ui/control-tray.tsx`, `ui/`; `features/profile/profile-icons.ts` and settings `profile-appearance.tsx` | Reuse the glyph, palette, curated icon catalogue and existing picker behaviour. Extract a shared icon chooser if needed; do not duplicate profile settings or introduce a second palette. |
| Agent authoring | Existing managed accounts, Monaco buffers/drafts/conflicts, puddlang CLI/MCP | Add huddle docs, templates, validation and explicit authoring assistance. Automatic delegated MCP and shared descendant budgets are not implemented today. |

Paths in this table are relative to `packages/` unless a package is named.
Live puddlang acceptance remains pending for all four providers in both modes.
Huddle release evidence must include real selected providers; fake-agent tests do
not establish exact native turn completion, permissions or SSH continuity.

## 3. Identity, scope and session lifecycle

Keep these identities separate:

| Identity | Meaning |
| --- | --- |
| Definition id | Random hex huddle id, stable across renames, identifying `.puddle/huddle/<huddle_id>/` within the selected worktree. |
| Revision digest | Immutable snapshot of the graph, contracts, scripts and component versions admitted for execution. |
| Session/placement id | A huddle installed in one host/profile/project and canonical definition worktree. It participates in normal session navigation and archiving. |
| Runtime id and incarnation | The independent live owner of that placement's graph, triggers and journal. |
| Execution id | One root trigger event and its bounded causal chain through the graph. |
| Invocation/operation id | One node activation or exact external operation within that execution. |

A definition can be copied between worktrees/hosts without copying live ownership.
The installation key includes host, profile, project, canonical definition
worktree and definition id; a copied huddle id alone never adopts another runtime.
Opening the same installed huddle twice creates two views of one placement.
Creating an independent duplicate is explicit and produces a new definition id.

Use the existing sessions table for the third placement kind, with related huddle
tables for definition binding, selected revision and lifecycle intent. Huddles
have no placement-level agent account or native conversation; individual nodes
select their own accounts and managed agents. Keep branch ownership explicit:
installing a huddle into an existing worktree does not acquire permission to
delete that worktree or branch.

Every file, Git or session operation declares a worktree, either a literal
selector or a typed variable. The definition worktree is a visible binding that
nodes can reference, not an invisible cwd fallback. Resolve bindings against the
chosen host/profile's registered project/worktrees; store canonical paths and
resolved identities with each invocation. Reject ambiguous or missing targets.
Selecting an existing agent also checks that its actual project/worktree agrees
with the declared binding. Recheck its runtime, placement and native conversation
before dispatch. A huddle may address several explicitly declared worktrees in
its profile; cross-profile/host orchestration is deferred.

| Action | Proposed behaviour |
| --- | --- |
| Create/open | Save or inspect a stopped definition; no execution side effects. |
| Start | Validate and activate one saved revision and binding set; start/adopt its owner and arm enabled triggers once. |
| Run | Admit one manual event with explicit input and an idempotency key; show execution acceptance separately from completion. |
| Interrupt | Suspend new dispatch and trigger admission, cancel exact active node work, and retain an interrupted huddle for inspection. Attached agents remain available; uncertain cancellation stays visible. |
| Resume/start after interruption | Explicitly re-arm future events and reconcile existing outcomes. Never replay interrupted script bodies or uncertain prompts. |
| Stop | Disarm triggers, fence queued work, settle/cancel active invocations, and shut down the huddle owner. Apply the declared owned-agent cleanup policy; retain files/history. |
| Archive | Complete the stop policy, then hide the placement through normal archive controls. Preserve the definition, graph history and worktree. Unarchive returns stopped. |
| Close tab/window | Detach a viewer only. The huddle and its triggers keep running. |

Project archive/removal and worktree pruning must include huddle owners, watchers,
pending launches and unresolved operations. A missing definition/worktree blocks
new work but must not hide Stop or prevent inspection of retained history.
An archive cannot claim completion while owner shutdown remains uncertain.

Default cleanup follows puddlang: completed executions retain their agents for
inspection; explicit interruption, cancellation, deadline expiry or huddle Stop
stops exact huddle-owned agents and interrupts only the huddle's pending asks on
attached agents. A separate explicit retention policy may leave owned agents
running. Never stop a replacement runtime later resumed in the same placement.
Stop/Interrupt mark queued executions cancelled rather than leaving them ready
to run on the next Start. Keep their events/history for inspection; re-running
cancelled input is a new explicit execution with a new identity.

Reuse coarse session statuses for navigation where their meaning fits; publish a
separate huddle projection for armed/idle, executing, blocked, stopping and trigger
health. An armed idle huddle is live, not exited. An unavailable observation is
not proof of stopped work. Lifecycle eligibility belongs in a shared kind-aware
policy used by menus, tabs, bulk actions and future mobile controls.

## 4. Nodes, ports and execution semantics

There are three node categories:

- **Trigger:** a versioned external event source with settings and typed output
  ports. It runs while the huddle is armed and feeds puddlang invocations.
- **Script:** a puddlang programme wrapped in `HuddleNode`, with declared input
  ports, output ports, parameters and resource/operation requirements.
- **Readout:** a versioned consumer of output, such as a result inspector, file
  writer, selected-session prompt or external integration. It reports delivery
  separately from the upstream node's success and may expose a typed receipt.

Ports carry bounded JSON values, typed resource references or managed artefact
references. A wire maps one named output to one named input. It carries data and
causality, not JavaScript objects, live handles or secret credentials. Readout
here includes downstream actions as well as presentation. Script-to-script wires
need no otherwise-empty readout node.

Use declarative JSON Schema contracts for portable metadata and runtime validation;
shared Zod schemas validate the graph/envelopes. Start with a documented subset
that supports objects, primitives, arrays, enums and explicit nullable values.
Only claim static compatibility when it can be proved; validate every resolved
input and every output at runtime. Invalid structured output never means approval.
Unknown schema keywords or component versions produce actionable diagnostics.

`HuddleNode` provides the execution wrapper, cancellation signal, immutable
parameters/input, scoped puddlang operations and validated output emission. The
following illustrates a module; `puddlang/huddle` is available inside captured
script workers, with application lifecycle and authoring integration implemented:

```ts
import { HuddleNode } from 'puddlang/huddle';
import { z } from 'zod';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, bindings, puddlang, signal }) {
    const agent = await puddlang.attach(bindings.agent);
    signal.throwIfAborted();
    const reply = await agent.ask({
      prompt: parameters.prompt,
      input: inputs.request,
      schema: z.object({ complete: z.boolean(), feedback: z.string() }),
    });
    return { completed: { reply } };
  },
});
```

This example's `node.json` declares an agent parameter, an explicit worktree
parameter, a prompt parameter, a `request` input and a `completed` output. The
wrapper resolves the selected agent into `bindings.agent` only after matching
its placement to the declared worktree. It validates values and manages exact
operation identities; this sketch does not define a second agent implementation.
Metadata is inspectable without evaluating module top-level code. A build/validate
step checks module/contract agreement. Application 28.31 implements that explicit
saved-source check with static syntax/import/wrapper diagnostics; workers still
validate the evaluated declaration. It does not execute top-level source or
replace full TypeScript checking. Ordinary Zod-based puddlang scripts can use
an explicit wrapper; revise puddlang where necessary and document the resulting
`pudl run` semantics.

Parameters describe titles, help, types, defaults, requiredness and editor hints:
account, agent type, mode, project, worktree, session, prompt template, duration,
enum and ordinary JSON fields. Resource pickers reuse Puddle's account/location
rules. Show effective defaults in fields. Binding references are tagged values
such as `{ "kind": "variable", "name": "targetWorktree" }`, not strings evaluated
as code. Literal bindings use `{ "kind": "literal", "value": ... }` so objects
cannot be confused with references.
Prompt interpolation supports named data references with a preview and missing
value errors; it must not use `eval` or interpolate through a shell. The node
inspector now previews standard `{{input}}` / `{{input.field}}` substitutions
against local sample JSON, sharing source with shipped agent and Format text
formatters. It reports missing values and UTF-8 size errors, labels variable
defaults and never executes custom scripts or sends sample data.

Graph execution rules must be explicit before building the canvas:

1. Each trigger event starts one execution with a correlation id, revision and
   resolved bindings. Nodes consume immutable values from that execution.
2. Default activation requires every required input for the same correlation id.
   Literal settings do not trigger execution. An explicit merge node handles
   alternative sources; a join node handles branches. Never combine unrelated
   events just because each input has a latest value.
3. Outputs become routable only after validation and a durable completion record.
   Fan-out shares the same causal identity; fan-in uses declared matching rules.
   Turn-completed output can be emitted before a larger node finishes only through
   an explicit durable event port, with its own stable emission sequence.
4. Default graph concurrency is one execution; default node concurrency is one.
   Queue/coalesce/drop policies are visible per trigger, with finite queue limits.
   An agent still rejects concurrent asks. Do not silently interrupt a busy agent.
   Application 28.29/runtime admission-1 implement graph defaults and per-trigger
   overrides. Coalesce supersedes only waiting input from the same source, port,
   revision and activation; Drop records skipped events for busy sources/full
   queues. History and source cursor progress remain durable and running work
   continues unchanged. Timer missed-occurrence policies remain separate.
5. Errors stop dependent nodes and appear in the execution inspector. Recovery
   paths require an explicit error port/policy; ordinary success wires receive no
   fabricated result. Retry defaults to off for operations with side effects.
6. Cycles require an explicit feedback boundary with a next-iteration token,
   finite round/turn/lifetime limits and an exit condition. Reject unbounded
   immediate cycles. Shared root budgets cover both directions and all fan-out.

Implemented routing semantics: a completion carries its input activation through
fan-out; an explicit event emission creates a new activation shared by its fan-out.
Ordinary joins match execution and activation, never latest values. An explicitly
`scope: "execution"` input retains one immutable delivery for that execution/node/port.
It supplies waiting and later activations, including feedback rounds, but never
starts an activation by itself. A competing delivery fails instead of replacing
that value. Such ports must be required, use `all` activation and accompany a
normal required input; feedback cannot target them. Optional runtime
`executionInputs: 1` gates this contract. Required inputs gate
admission; optional values arriving later cannot revise the admitted invocation.
Explicit `any` alternatives each create a separate activation and validate only
their supplied inputs. A feedback edge creates a new activation; distinct feedback
edges remain separate. The initial pass counts as round one, and feedback
boundaries increment the causal path's round count without resetting it at another
edge. A still-true continuation condition at the limit is a limit outcome, not
successful completion. The owner scheduler must persist and expose that outcome.

Start from puddlang's existing per-execution defaults (50 asks, eight cumulative
agent spawns and one hour), with a five-round default for the review template.
An armed schedule can live longer than an execution; it needs separate daily
admission/spawn limits, queue/storage limits and visible exhaustion behaviour.
Define concrete caps in shared schemas before enablement. Nested CLI invocations
currently create independent runs; do not claim their spending is covered by a
huddle budget until delegated execution is implemented. Built-in nodes must use
the scoped wrapper rather than escape through a nested CLI.

### Two agents talking to each other

The simplest template wires **Run → Prompt A → Prompt B → bounded feedback to
Prompt A**. Prompt nodes attach to selected agents or use handles produced by
explicit Spawn nodes. Their `completed` output comes from the exact `ask` result.
The reviewer emits `{ complete, feedback }`; approval exits to a readout and
feedback advances the iteration. Five rounds without approval is a distinct
limit outcome, not success. Same-worktree agents take turns; different worktrees
need an explicit patch/commit transfer before review can inspect changes.

Also support a **Puddle turn completed** trigger for selected existing agents,
including turns started outside the huddle. It must use retained native turn
identity, not a status change to `waiting_input` or terminal silence. Carry
originating huddle/execution/operation ids where available; suppress feedback
echoes by default. A workflow explicitly opts into a bounded feedback route.
Do not feed both an ask result and the matching completion trigger into the same
next invocation. Human steering/native conversation switches retain puddlang's
takeover rules; they are never attributed to the previous automated ask.

## 5. Extensible trigger and readout contracts

Build this as a provider-neutral puddlang extension surface used by huddles, not
a collection of hard-coded React nodes. Built-ins and project-local extensions
use the same versioned contracts and conformance tests.

| Contract | Required responsibilities |
| --- | --- |
| Component manifest | Stable namespaced id, version, category, contract version, input/output/parameter schemas, icon/colour defaults, entry point and declared capabilities. |
| Trigger adapter | Open a subscription from captured settings and a persisted cursor; emit stable event ids and typed payloads; report ready/degraded/gap states; checkpoint and dispose all resources. |
| Trigger acknowledgement | Advance a cursor only after durable inbox admission. Reconnection deduplicates stable ids. An explicit gap cannot be reported as successful catch-up. |
| Readout adapter | Accept an immutable delivery envelope and idempotency key; return delivered/failed/unknown with a bounded receipt; declare cancellation and reconciliation support. |
| Readout observation | Query an uncertain delivery where the destination supports it. Retry only under a declared safe policy; no universal exactly-once external-delivery promise. |
| Host context | Provide scoped resource resolution, abort signals, bounded logging, checkpoint access and approved integration-secret references. No application token or host master credential enters graph files. |

The common event envelope includes contract version, source/component id, stable
event id, observed/occurred timestamps, host/profile/project scope, applicable
worktree/session/runtime/turn identity, correlation/causation ids and typed data.
The delivery envelope also binds graph revision, node, all named input ports and invocation.
Define payload/count/time bounds and cursor expiry behaviour in the contracts.

Custom trigger/readout source lives in the project and executes on its host in
supervised workers, never inside the renderer or daemon event loop. Inspecting a
graph or opening its settings does not execute extensions. Activation pins exact
source and manifests, and requires an explicit decision to run trusted project
code. Puddlang and these extensions have the OS user's authority: capability
declarations help validation and operator review, but are not a security sandbox.
Keep one component's failure, runaway logging or blocked I/O from freezing the
owner or other subscriptions; bound worker resources and startup/shutdown waits.

First support project-local components plus bundled built-ins. Resolve an explicit
local dependency list into an immutable bundle; reject paths outside the allowed
definition/component roots and unexpected symlink escapes. Captured huddle workers
now load these declared closures and the pinned HuddleNode/puddlang/zod helpers;
the ordinary `pudl run` entry point still supports only one source file. No
automatic npm installation, package marketplace or inbound public
webhook listener is required for the first release. Those can extend the same
contracts later. Missing components remain visible as unresolved nodes.

### Initial catalogue

| Family | Initial nodes and settings | Required semantics |
| --- | --- | --- |
| Host triggers | Interval, one-off date/time, recurring calendar schedule; timezone and missed-event policy | Persist scheduled occurrence identity. Define DST/repeated-hour behaviour. Default to coalescing missed occurrences into one labelled event, with explicit skip or bounded catch-up options. No tight idle polling. |
| Filetree triggers | Create/change/remove under a selected worktree, glob filters and debounce | Watch atomic saves/renames and external changes; exclude `.git`, huddle definitions and declared output paths by default. Reconcile a bounded snapshot after gaps; report net changes, not fictional intermediate events. |
| Git triggers | Commit/ref change and tag creation/deletion in a declared repository/worktree | Observe Git written by any tool. Retain old/new OIDs and ref names, handle force updates and worktree HEAD changes, and deduplicate common-directory events across linked worktrees. |
| Puddle triggers | Manual Run, selected agent/session start/stop/archive, status transition, exact turn completion | Filter by stable scope and resource selectors. Distinguish observed state from exact completion; surface event-retention gaps. |
| Agent lifecycle scripts | Spawn agent with account/provider/mode/project/worktree/prompt; attach and prompt selected agent; resume stopped agent; inspect and restart selected runtime | Reuse account gates, exact handles and runtime controls. Resume, prompt and restart are separate operations with explicit impact; never restart on a generic prompt failure. |
| Flow scripts | Map/format data, structured condition, merge/join, bounded feedback | Implement through normal wrapped scripts and declared contracts, keeping routing inspectable. |
| Readouts | Result/history, write a report to a declared worktree/path, feed a selected agent, invoke a custom downstream adapter | Preserve completion/delivery distinction; file writes use conflict-aware policy and external actions use durable delivery records. |

Restart nodes require a separate design check against `sessions/runtime/`:
snapshot the exact owner, selected release, affected terminals and restart impact,
then use an explicit policy/approval appropriate to that invocation. Changed
targets or uncertain replies block further action. A generic trigger is not
permission to stop an unrelated or replacement runtime. Initial lifecycle nodes
can ship spawn/attach/prompt/resume before this restart gate is complete.
Implemented policy: an activated component with `lifecycle: "restart"` authorises
replacement of its captured runtime, including its terminals, using the installed
runtime selection. The ordinary inspection/restart service captures and rechecks
its impact fingerprint; the host operation retains that review before dispatch.
It never follows a replacement runtime or retries an uncertain action.

## 6. Project storage and agent-friendly authoring

Each project worktree can contain **multiple independent huddles**. Store each
one under **`.puddle/huddle/<huddle_id>/` at the selected project worktree root**.
The parent directory is a collection, not a huddle definition. Generate each
`huddle_id` from 16 cryptographically random bytes encoded as 32 lowercase hex
characters, checking for collisions before creation. The id is independent of
the editable display name and remains unchanged when the huddle is renamed.

Keep each huddle's manifest, layout, scripts, custom components, fixtures and
documentation inside its own directory. Everything needed to understand and edit
that graph is ordinary text:

```text
.puddle/huddle/
  50dbbe542e6d45da98cda2baaa212a65/   # huddle id; display name: Review loop
    huddle.json                      # identity, nodes, edges, variables, policies
    layout.json                      # shared node positions/optional groups only
    components/                      # this huddle's custom extensions
      git-report/
        component.json              # manifest and declared dependency list
        trigger.ts                  # or readout.ts, depending on category
        schemas/
          event.json
        tests/
          examples.json             # deterministic contract examples
    nodes/
      review/
        node.json                   # ports, parameter schemas and editor hints
        run.ts                      # HuddleNode-wrapped puddlang source
    fixtures/
      manual-input.json
      expected-review.json
    README.md                       # purpose, bindings and how to exercise it
  c8e6a10437bd592f80a12d9e46bc7350/   # another independent huddle
    huddle.json
    layout.json
    nodes/
    README.md
```

Discovery enumerates huddle-id directories and validates each independently.
The manifest id must match its directory name; duplicate display names are
allowed. One malformed huddle must not prevent opening others. Duplication
creates a fresh random id, directory and matching manifest id, without copying
private runtime ownership or activating the copy. Do not use human-readable names
as directory identities or introduce a project-wide singleton `huddle.json`.

`huddle.json` references bundled component versions or relative project modules;
it contains node instances and their parameters, not embedded source strings.
Use format versions, stable human-readable node/port ids, stable edge ids,
relative paths and deterministic formatting. Component versions resolve to
recorded digests on activation. Export JSON Schemas and TypeScript definitions
for editor completion and agent validation. Unknown future formats open read-only
with diagnostics; never discard unknown fields in a downgrade save.

This manifest follows the implemented format-1 document schema; its local
component and runtime still need to be supplied before it can execute:

```json
{
  "format": 1,
  "id": "50dbbe542e6d45da98cda2baaa212a65",
  "name": "Review loop",
  "variables": {
    "targetWorktree": { "schema": { "type": "string" }, "editor": "worktree", "required": true },
    "reviewAgent": { "schema": { "type": "string" }, "editor": "session", "required": true }
  },
  "nodes": [
    { "id": "run", "source": { "kind": "builtin", "component": "puddle.trigger.manual", "version": 1 }, "parameters": {} },
    {
      "id": "review",
      "source": { "kind": "local", "manifest": "./nodes/review/node.json" },
      "parameters": {
        "worktree": { "kind": "variable", "name": "targetWorktree" },
        "agent": { "kind": "variable", "name": "reviewAgent" },
        "prompt": { "kind": "literal", "value": "Inspect the requested changes and return structured feedback." }
      },
      "appearance": { "icon": "search", "colour": null }
    }
  ],
  "edges": [
    { "id": "run-review", "from": { "node": "run", "port": "event" }, "to": { "node": "review", "port": "request" } }
  ],
  "execution": { "concurrency": 1, "maxTurns": 50, "maxAgents": 8 }
}
```

Final appearance encoding must reuse existing icon/colour schemas, with null
selecting the default styling; the fragment's remaining spelling is illustrative.
Portable files may name logical accounts and worktree variables; resolved host
ids and optional machine-specific binding values stay in private installation
state. A literal worktree declaration is supported but visibly non-portable.
Account login secrets are never exported. Integration secrets use references to
private host configuration, with redacted diagnostics and explicit availability.

Keep these three storage layers distinct:

1. **Editable source:** the files above, with normal Git review, Monaco buffers,
   drafts and conflict resolution. Pan/zoom, selection and inspector state are
   per-view workspace state; they do not churn tracked graph files.
2. **Activated revision:** a privately captured, hashed bundle of manifest,
   scripts, schemas, resolved component versions and execution settings. Capture
   bounded files and verify they did not change during validation; atomically
   publish only a complete snapshot. Existing invocations retain their revision.
3. **Runtime state:** private records under Puddle home for placements/bindings,
   owner claims, trigger cursors, inbox/outbox, invocations, outcomes and artefacts.
   Never put PID files, delivery queues, credentials or live logs in the repository.

Saving edits never activates them. Show Draft versus Active revision and offer
Validate and Apply. Applying a new revision fences old subscriptions, establishes
a defined cursor hand-off and changes future admissions atomically. In-flight
executions finish against their old revision unless explicitly interrupted;
retain their components and checkpoints until safe to collect. An invalid edit,
branch checkout or removed source must not silently replace a valid active bundle.
External agent edits refresh the draft and surface conflicts, without running it.

The owner is the sole writer of its private execution ledger. The daemon remains
the sole writer of application SQLite and projects committed owner observations
into it, using cursor/acknowledgement reconciliation like existing runtimes. The
initial implementation uses a versioned owner-local SQLite ledger; do not let two
processes independently update the same execution authority.

## 7. Independent huddle runtime and recovery

Implement a huddle role in the installed runtime distribution, reusing independent
service launch, permanent claims, process identity, bounded transport, memory
admission and pinned release handling. Each live huddle gets one owner, independent
of puddled and independent of the managed agents it controls. Node and extension
workers are children of that huddle owner; agent runtimes keep their existing
ownership and lifecycle. Do not nest agents under a service that kills them when
the huddle exits, or copy the agent owner wholesale into a second implementation.

The huddle owner holds the active revision, scheduler, trigger subscriptions,
durable inbox/outbox, execution budgets, node workers and operation ledger. Puddled
provides authorised control, application-state projection, account/worktree
resolution and dispatch into existing session services. Use a private,
profile-scoped huddle control identity bound to its owner/incarnation; a browser
lease, lifecycle nonce or raw environment id must not become persistent authority.
Revalidate scope and exact targets after asynchronous work and at dispatch.

This requires a new host operation bridge. The host-side exact-turn adapter is
now implemented under `huddle/operations/turns/`, sharing the ordinary dispatcher
with separate durable huddle identities and result receipts. Private owner
transport and script attach/ask queueing now live under `runtime/huddle/operations/`;
production dispatch and exact session-resource admission now compose these
through `huddle/operations/dispatch/`. The owner spawn outbox and execution-owned
handles now live under `runtime/huddle/operations/spawns/`; separate private spawn
messages are composed by the owner behind optional `spawns: 1`, now advertised. Automatic
spawn dispatch now shares the daemon operation queue and maintenance gate. Start/Apply
resolve explicit account ids, matching scripted-turn providers, the source project
and canonical registered worktrees, with admission rechecks and owner capability
gates. Owned-agent cleanup now has separate retained intent/acknowledgements and
shares the operation dispatcher. Resume/restart now use a third lifecycle lane,
calling existing SessionService controls and retaining exact replacement identity
with migration 50; they do not acquire spawn cleanup ownership. Ordinary
puddlang runner operations still depend on a daemon-owned run record. Extract/reuse their agent
semantics with an explicit owner caller type and durable invocation keys. During
daemon absence, owner-local triggers and scripts can continue; operations needing
daemon account/session/worktree control wait within declared limits. Reconnection
observes accepted operations before any new dispatch. Do not give huddle workers
the host master credential or silently start a daemon from an agent environment.

### What survives which restart

| Event | Required outcome |
| --- | --- |
| Frontend close/reload or SSH viewer disconnect | Owner, workers, schedules and watches continue under their admitted host lifetime. Reopening observes the same identities. |
| Daemon replacement | Owner and node workers remain alive; local triggers keep recording events. Accepted agent turns continue in their owners. Daemon-dependent operations wait; the new daemon adopts retained events and outcomes without redispatch. |
| Huddle worker failure | The owner records interruption/failure for that invocation. Other nodes/subscriptions follow the declared failure policy. Unknown external effects are reconciled, never assumed absent. |
| Huddle owner crash | A single replacement, after positive old-owner/child fencing, restores subscriptions and durable queues. Completed nodes are not rerun. In-flight arbitrary TypeScript is interrupted; reconcile its recorded operations and expose unresolved work. |
| Machine reboot | Re-establish owners according to an explicit huddle auto-start setting and the last armed/stopped intent. Restore cursors and pending durable events; apply missed-event policy. Lost script/process memory cannot be reconstructed. |
| Limited SSH/host-session supervision | Report the same limited lifetime as ordinary runtimes. Either refuse an always-on huddle requirement or expose the limitation explicitly; process-group separation alone does not establish logout survival. |

**Surviving daemon replacement is not durable continuation of arbitrary
JavaScript after an owner crash.** The graph and trigger service recover from
durable records; an in-flight script body cannot be resumed at its previous
`await`. Checkpointable built-in nodes may recover through named, versioned state
transitions. Arbitrary nodes require explicit user-directed recovery or a declared
safe retry policy after their external effects are reconciled. Keep this visible
in both node documentation and the run inspector.

Recovery prerequisite now implemented: ask/spawn intent commits an immutable
`operation-origins` record with its exact caller identity in the same ledger
transaction. Mailbox observation, settlement and spawn cleanup preserve that
origin across reconstruction; they do not relabel old work as a new incarnation.
Explicit reboot recovery now uses verified boot change and retirement claims to
fence descendants, one atomic predecessor/successor mapping, a copied ledger and
restored subscriptions/queues. Old operations retain observation-only host authority.
Explicit per-run auto-start is implemented in 28.16. Application 28.18 adds
explicit same-boot recovery with retained Linux systemd/cgroup-v2 containment;
bounded automatic Linux recovery follows in 28.19. Application 28.24 adds macOS
launchd resource-coalition fencing through the same recovery path, including normal
service retirement before kernel reaping. Native crash/queued-work acceptance passes
on macOS 26.5.2 arm64. Detached host-session recovery and broader platform acceptance
remain open; missing native proof never permits a PID-based substitute.
Legacy rows without provenance must retain their verified original launch identity;
never backfill them from a replacement's identity.

Before each prompt, spawn, restart, file write or readout delivery, persist intent
and an operation id. Retain exact resource identity, attempt state and outcome.
Lost replies do not reset dispatch consumption. Record a node's completion and
outgoing events together so a crash cannot lose an edge or deliver it twice as
two distinct invocations. Durable inbox deduplication is local to the huddle;
external systems need their own idempotency/reconciliation support.

Triggers must work without a renderer. Host time and filesystem/Git observation
belong to the owner or its supervised adapters. Reuse bounded watcher techniques,
with no per-tab timers or Git subprocesses. Puddle lifecycle/turn subscriptions
need a retained source stream with cursors, scoped reads and gap reporting; the
current public WS feed is not sufficient. Retain events at their authoritative
agent/runtime source through daemon absence, and acknowledge only after durable
huddle admission. If a retention limit prevents continuity, show a blocked/gap
state instead of silently dropping or fabricating a turn-completed event.

Bound subscription count, disk/memory, queue length, output size and retry cadence.
Storage exhaustion stops new admission before unrecorded external work starts;
it must not silently discard accepted events or terminate unrelated agent PTYs.
Trigger health and backlog remain inspectable, including missed/coalesced events.
Share host resource admission and reference-aware release/artefact collection;
retained old graph revisions and workers pin their dependencies until safe to retire.

## 8. Compatibility, authority and rollout

Keep existing agent and terminal runtime contracts backward compatible. A newer
daemon must continue adopting supported older owners; installing huddle support
must not restart or convert them. Feature support comes from the exact selected
runtime's passive metadata and confirmed live handshake, not its release name or
the mere presence of `puddler`. Advertise huddle role, graph/contract support and
required retained-state compatibility using explicit bounded capabilities.

Gate **creation and start** in both frontend and daemon on runtime and daemon
support. Missing metadata means unsupported. A newer frontend can still inspect
plain definition files on an unsupported host, with an upgrade explanation; it
cannot create a huddle placement, dispatch a new role to an old executable, or
fall back to a daemon-owned runner. Recheck the pinned runtime selection before
launch intent. Existing huddles remain attached to their capable pinned owners
when the default runtime changes; unsupported defaults block new launches only.

Adding `huddle` to the current closed session-kind enum and tab union is a breaking
**application** change unless an explicitly negotiated representation prevents
old readers/writers from seeing it. The session-kind change now allocates
application **27.0**, requiring a coordinated frontend/daemon update. Application **28.0** adds the huddle tab variant. Desktop persistence **4**
migrates versions 2/3 and the preload advertises huddle support; older writers
must not erase huddle content. Maintain these boundaries after reading
[PROTOCOL.md](../../packages/shared/PROTOCOL.md).

The private runtime protocol has a separate compatibility boundary. Prefer an
optional role/capability extension that leaves old agent messages and retained
records unchanged; route new huddle messages only to capable owners. If a new
runtime major is unavoidable, the new daemon must explicitly support both old
agent owners and new huddle owners. Include huddle records in candidate capability
checks, host-update adoption evidence, interruption review, shutdown checkpoints,
installation/removal and release collection. An unsupported replacement daemon
must be rejected before disrupting running huddles.

Initial execution/control is local/SSH, matching puddlang. A plugin is not an
implicit remote transport or HTTP listener. Remote/mobile huddle execution needs
separate connector allowlist, profile authority and encrypted-envelope work;
until then reject it explicitly and keep ordinary remote session listings usable
through the chosen application compatibility boundary. Do not leak source,
private replies, account secrets or host-control evidence through status events.

## 9. Huddle IDE and ordinary windows

The IDE is normal workspace content. Add a `huddle` tab reference bound to its
placement, with preview/pin semantics, split panes, tab drag, detached windows,
docking, project windows, named layouts and restoration. A view change never
creates another runtime, trigger subscription or pending prompt. Browser panes
work without Electron; native window features use the existing desktop bridge.

Extend tab identity/key helpers, layout traversal, session-to-project lookup,
project extraction/return, transfer planning, view-state capture, dirty-buffer
review and missing-resource recovery together. Current helpers often assume
every non-editor tab is a terminal; audit those assumptions. Preserve unique
pane/view identities and existing staged handoff/rollback semantics. Native
shell code handles windows only; graph execution remains on the selected host.

The initial IDE contains:

- A quiet canvas with movable node islands, labelled input/output sockets,
  directional wires, zoom/pan, fit selection and a searchable add-node action.
- A compact action tray for Validate, Apply, Start/Run and lifecycle controls,
  showing the active revision and meaningful status without duplicate indicators.
- A node inspector opened by selection, with generated parameter controls,
  resolved-binding previews and an **Open script** action. Bundled nodes expose
  readable source; **Make local copy** creates an editable project component.
  Editing source uses Monaco and the existing draft/conflict system.
  The local binding preview is implemented: sample variables resolve current draft
  settings through the shared validator without executing modules. Resource selectors
  still require host activation; Active revision shows captured runtime bindings.
  Built-in local copies are implemented on application 28.30: ordinary draft
  edits retain node identity/settings/wires. Trigger copies declare a pinned
  hostTrigger and use HuddleNode to adapt each admitted event, preserving existing
  host source observation/cursors; runtime hostTriggerScripts-1 gates execution.
  Source and Result adapters also ship in the authoring kit. Native/provider
  acceptance remains part of the overall phase gates.
- An execution inspector for trigger input, node state, bounded input/output,
  exact agent/session links, errors, delivery receipts and recovery choices.
  Definition selection and viewing a historical execution are separate modes.
- Keyboard-accessible add/connect/disconnect/select/move/delete operations,
  undo/redo for graph edits, and a list/inspector alternative to precise wire
  dragging. Graph undo never undoes an external action already executed.

Use existing surface, tray, field, menu and motion primitives. Nodes may be
floating islands, with restrained outlines only where those islands need
definition. Settings are aligned text and controls with breathing room, not
boxes inside boxes. Match editor typography and host-accent selection; preserve
explicit node colours independently of semantic error/status colours. Custom
colours and icons reuse the existing pickers/catalogue, with readable theme
fallbacks and labels so meaning never relies on colour alone.

Hover changes fill and cursor immediately, never border thickness. Support
keyboard focus and coarse pointers without hover-only essentials. Connections
can use restrained theme colours and labels; no permanent flashing traffic or
idle wire animation. Respect reduced motion. No heavy grid by default; an optional
subtle alignment aid must use theme tokens. Large graphs need viewport culling,
bounded output rendering and measurement before adding a graph library. Choose
the canvas implementation in the UI phase based on accessibility, integration,
licence and performance; no library is selected by this roadmap.

Graph edits from two windows or an agent share a document revision and explicit
conflict handling, not last-writer-wins replacement. Closing a dirty huddle view
uses normal save/discard/cancel review; quitting preserves recoverable drafts.
Closing a saved view leaves execution alone. Missing sources show retained active
revision/history and recovery actions rather than a blank editor.

## 10. Agents authoring huddles

Implemented first increment: **Edit with agent** starts an ordinary managed
session using an explicitly selected logged-in account in the current profile,
joined to the huddle's exact worktree. The initial prompt contains the definition
directory, application protocol, task and bundled `puddle-huddle` skill. The skill
is supplied as context for every provider; no personal skill installation is
assumed or overwritten. Local dirty source/conflicts block launch. Saving and
agent completion remain separate from graph activation. See the
[authoring guide](../huddle/authoring.md) and [acceptance](../acceptance/huddle.md).
Source discovery/inspection/validation now share the inactive host API through
`pudl huddle list|inspect|validate` and `huddle_list|inspect|validate` MCP tools.
They require explicit project/worktree scope on the selected host and never
evaluate modules or create a runtime. Validation reports source diagnostics and
a digest; it is not live execution admission. Inactive create/open and core
runtime/start/apply/run/interrupt/resume/stop/history/readout-observation tools
now reuse the same host services, exact reviewed source digests and owner targets.
Failed mutations are observation-only until the user decides a next action; no
tool implicitly refreshes targets or retries. `pudl huddle authoring [asset-path]`
and `huddle_authoring` now expose a client-bundled kit: structural JSON Schemas,
generated wrapper types, editable transform/pull-feed/report components, example
graphs and fake fixtures. Kit reads need no host or source mutation; the reported
client protocol is not target-host capability evidence. Real-provider authoring,
richer integrations remain unfinished. Application 28.23 adds private host
integration grants and secret parameter references, checked at activation and
worker startup with redacted diagnostics. Host configuration is edited directly;
existing workers retain values until interrupted/stopped. Recorded revisions are
now inspectable through 28.13 without a connected owner.

Let users select any eligible account in the current profile to create or modify
a huddle through an ordinary managed agent. The authoring agent is distinct from
agents used by the graph. Keep provider/version capability checks and permission
gates; unavailable selected accounts fail without charging another account.

Ship a huddle authoring guide, a huddle-specific skill, JSON Schemas, wrapper
types, small examples and trigger/readout templates. Agent instructions should
explain the directory map, worktree declarations, port contracts, operation
identity, feedback budgets, validation and the difference between saving and
activating. Use existing adapter-owned skill/onboarding mechanisms where they
fit, with an explicit installation/binding design; do not silently overwrite
users' skills or assume every provider supports identical discovery.

Expose discovery, validate, inspect/diff, activate and lifecycle operations through
shared host services, then CLI/MCP entry points. The implemented source syntax is
`pudl huddle validate <id> --project <id> --worktree <absolute-host-root>`;
this replaces the proposed directory-only form. Core runtime controls are exposed
with `--request JSON` (MCP: `{session_id, request}`). Placement observation and
archive/unarchive are also available through CLI/MCP, reusing normal session
lifecycle after a host-side profile/kind check. Archive stops the current owner;
unarchive leaves the placement stopped. Application 28.10 adds `revision` and
`diff` tools: an explicit owner target, reviewed saved digest for comparison and
optional source/contract entry selection. The IDE includes Active revision and
shows this comparison before Apply; it never substitutes a newer digest.
Validation returns stable node/port/path diagnostics and, on 28.31+, supports
selected JSON fixture files with node input/parameter/output/event samples,
using runtime contract validators without arming live triggers or contacting providers. Source
inspection must not evaluate custom modules. Executing component tests is a
separate trusted-code action with fake event/readout fixtures.

An IDE authoring action supplies the exact definition directory/worktree and task
to the selected agent. The agent edits ordinary project files; the IDE observes
those edits and presents validation/diff. Saving files or receiving an agent's
success claim never activates code. Activation requires explicit user intent or
an already-authorised automation policy. Generated scripts inherit no broader
authority than other trusted project scripts, and authoring does not automatically
enable nested delegation, cross-profile access or unlimited agent budgets.

## 11. Phased implementation and release gates

Phases 0–4 are **in progress**; phase 5 has window integration, IDE authoring assistance and a standalone authoring kit, with provider-backed authoring acceptance unfinished. Recorded revision/source
inspection is implemented in 28.13. Phase 6
has preparatory host maintenance integration, with packaged acceptance pending.
Phase 1 currently has the private inbox/outbox, node-attempt and exact-operation
ledger plus durable
graph routing, isolated script workers, retained revisions/activation and a manual
scheduler and independent owner process/private control. Production launch/adoption
and maintenance integration are implemented; attach/ask dispatch is wired, while native provider/lifecycle continuity acceptance remains unfinished. Phase 2 has
inactive creation/opening, sidebar integration and manifest graph editing with
shared editor drafts, movable nodes and local/SSH manual lifecycle/history APIs;
active-revision details and saved-source comparison are implemented. Supporting
local/SSH hosts now use captured manifest/layout saves with shared source-tab
baselines, IndexedDB/native draft metadata, dependency conflict review and guarded
Keep mine; missing old metadata requires review. Explicit invalid-source repair
retains its narrower file guard. Application 28.12 adds recorded owner discovery and stopped-owner execution/result
history through the IDE and CLI/MCP, without restarting owners. Execution limits,
owned-agent cleanup and node concurrency now have IDE controls sharing draft,
undo and explicit Save/Apply. Application 28.17 adds unified trigger health and
accepted-backlog inspection; native/provider/platform acceptance remains pending. Application 28.13 adds recorded
activation/historical source inspection and exact saved comparisons through CLI/MCP.
The IDE now has reviewed lifecycle controls, manual input and live result inspection,
plus initial editable prompt/review templates and connection feedback settings;
phase 3 now includes resume/restart; provider-native acceptance remains. Each phase
must update
`docs/acceptance/huddle.md` with implemented details and evidence, rather than
leaving the only accurate description in code or marking future phases complete.

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| 0 — Contracts and fixtures | Finalise identities, worktree binding, document/schema versions, lifecycle policy, event/port semantics, limits and compatibility plan. Add minimal manual-run and two-agent graph fixtures. | Deterministic validation accepts intended graphs and rejects ambiguous scopes, invalid ports, unsafe cycles and unsupported formats without executing modules. Document API/storage decisions. |
| 1 — Independent owner | Huddle runtime role, private operation bridge, durable inbox/outbox and revision capture, ownership/claims, daemon adoption and capability-gated admission. Start with manual trigger and fake nodes. | Owner survives daemon replacement; lost dispatch replies do not duplicate work; old agent/terminal owners still run; incompatible runtime refuses creation before side effects. Fault injection covers owner crash and storage exhaustion. |
| 2 — Session and IDE vertical slice | Third session kind, sidebar tray/rail actions, Puddle glyph, create/open/archive, graph canvas, node settings/source inspection and manual Run/result history. | Blank/template huddle saves to the declared worktree; settings and source round-trip; two views observe one owner; UI follows HUMANS in both themes, host accents and reduced motion. |
| 3 — Agent orchestration | Wrapped puddlang nodes, spawn/attach/prompt/resume, typed completion ports, structured review and bounded feedback. Restart node follows its separate impact/recovery gate. | Real coder/reviewer loop, exact native histories, two agents exchanging replies, busy-agent rejection, permission/takeover handling and cancellation. Test same and distinct worktrees. |
| 4 — Triggers and extensions | Host/Filetree/Git/Puddle trigger families, durable source cursors, project-local trigger/readout SDK and initial output adapters. | No open frontend required; duplicate/gap/missed-event policies verified; custom trigger and custom readout load through the same contracts; uncertain external delivery stays inspectable. |
| 5 — Full windows and authoring | Huddle tab transfers/docking/layouts/recovery, shared drafts/conflicts, account-selectable authoring, shipped skill/docs/templates and CLI/MCP parity. Basic in-pane tab support begins in phase 2. | Headless window flows preserve graph/draft/view identity without starting owners. Two-window/agent edit conflicts and source-loss recovery pass. Agent can create a validated custom component from shipped docs. |
| 6 — Packaged acceptance | Installation/update/removal, mixed runtime versions, native supervision, SSH, owner restart and reboot, resource/battery measurements. | Recorded platform/provider matrix, no unsupported continuity claims, and a complete acceptance document with remaining limits clearly marked. |

Do not call the feature complete at the first canvas demo. Runtime continuity,
working triggers, bounded feedback, source authoring and normal tab/window
behaviour are part of the requested feature. Marketplace distribution, public
webhooks, cross-host graphs and transparent continuation of arbitrary TypeScript
after process loss are later extensions, not prerequisites for the first release.

## 12. Code organisation and verification instructions

**Organise implementation hierarchically by responsibility.** Keep composition
files at feature roots, supporting logic beside its feature and tests in matching
subdirectories. Do not accumulate a flat directory of graph, trigger, runtime,
editor and recovery helpers, or add forwarding files just to preserve internal
paths. Reuse existing ownership, account, worktree and window services instead of
introducing parallel registries.

Proposed directory responsibilities, to refine against the code at implementation
time:

```text
packages/shared/src/
  api/huddle/                   # definitions, bindings, nodes, runs, lifecycle
  runtime/huddle/               # private owner commands, events, retained state
  desktop/windows/              # extend existing content/transfer contracts
packages/daemon/src/
  huddle/
    definitions/                # discovery, validation, snapshots, revisions
    bindings/                   # project/worktree/account/session resolution
    control/                    # authorised lifecycle and daemon projection
    components/                 # manifest registry and built-in definitions
  runtime/huddle/
    execution/                  # scheduler, ports, node workers, budgets
    triggers/                   # host/, filetree/, git/, puddle/
    readouts/                   # result/, files/, integrations/
    state/                      # inbox/outbox, checkpoints, outcomes
    recovery/                   # exact-operation reconciliation
  puddlang/                     # shared wrapper/operation seams, grouped as needed
  http/routes/execution/huddle/ # thin validated routes
packages/web/src/features/huddle/
  canvas/                       # graph composition, sockets, wires, gestures
  nodes/                        # library, settings, appearance, source actions
  documents/                    # models, revisions, drafts, conflicts
  execution/                    # inspectors, receipts, runtime health
  authoring/                    # agent-assisted editing entry points
packages/cli/src/
  huddle/                       # thin CLI/MCP command composition if needed
```

Keep session/sidebar integration under `workspace/sessions/`, tab/pane integration
under workspace and existing window groups, and provider-specific behaviour under
`daemon/src/agents/<provider>/`. Share generic watch primitives in a deliberate
common module only when both compilation and huddle need them. Keep numbered
migrations in their existing ordered directory. Update build entry points, pinned
runtime assets, archive manifests and smoke fixtures when adding executable or
worker modules; preserve existing package public entry points.

The future acceptance document must cover at least:

- Graph/source/settings round-trip, external edits, multi-file capture races,
  invalid contracts and schema migrations; no code evaluation during discovery.
- Canonical worktree variables/literals, same paths in different profiles, missing
  paths, symlink escapes, account ambiguity and unchanged permission gates.
- Start/interrupt/resume/stop/archive/unarchive, project archive, missing resources,
  exact owned-versus-attached agent cleanup and viewer-only closure.
- Duplicate trigger ids, join correlation, concurrent asks, bounded cycles,
  feedback echo suppression, malformed outputs and delivery receipts.
- Clock changes/DST, event storms, external file/Git changes, watcher recovery,
  source retention gaps, backpressure and idle CPU/wakeups with no frontend.
- Crashes before/after durable intent, after external acceptance and before outcome
  acknowledgement; no duplicate prompts/spawns/writes on reconnect or adoption.
- Daemon replacement with active scripts, huddle owner crash, machine reboot,
  service-manager and limited-host lifetimes, plus SSH disconnect/reconnect.
- Older agent/terminal runtimes beside capable huddle owners, unsupported creation,
  saved-layout compatibility, candidate daemon rejection and pinned-release retention.
- Native provider acceptance for supported modes and exact turn-completion sources;
  explicitly retain Pending cells where only fake-agent evidence exists.
- Split panes, project windows, detach/dock, dirty close review, lost transfer reply,
  renderer crash, duplicate views, named layouts and missing-source restoration.
- Keyboard/touch access, both themes, accent/custom colours, reduced motion, large
  graphs and the shared UI token checks.

Use isolated fixtures and headless window checks first. Real native window checks
change focus/fullscreen and require the user's explicit request under repository
conventions. Never launch a production daemon from an inherited coding-agent
environment. Documentation-only planning does not require starting agents,
services, triggers or interactive desktop tests.
