# Huddles: current usage

For custom components, use the [packaged authoring kit](huddle/authoring.md#packaged-authoring-kit):
`pudl huddle authoring` lists schemas, wrapper types, templates and fake fixtures;
an exact asset path reads its content without activating or changing a huddle.
The [executable fixture guide](huddle/testing.md) covers local component checks
with fake fetch responses and agent replies using the kit's standalone runner.

On application 28.32+, history's **Operations** view offers **Open agent session**
for recorded agent actions, including retained history after Stop. It shows the
recorded worktree and runtime; the session may now have a different runtime or
conversation. Opening it does not resume, restart or resend anything.

Huddles are project orchestration graphs powered by puddlang. This guide describes
the implemented local/SSH workflow. The [roadmap](roadmap/huddle.md) covers the full
design; [acceptance](acceptance/huddle.md) records verified behaviour and remaining
work. Interval, calendar and one-off date triggers are available on supporting
runtimes. Filetree, Git, session lifecycle/status and exact external turn-completion
observation are also available. [Custom readouts](huddle/readouts.md) can deliver
graph outputs to external services on supporting runtimes. [Custom triggers](huddle/triggers.md)
can subscribe to external sources with durable cursors and visible source health.
Spawn agent creates an agent and sends its initial prompt. Resume agent and Restart
agent use ordinary Puddle lifecycle controls, retain the selected conversation and
send the configured prompt. Native-confirmed prompt/review templates are available on application 28.20. Source inspection, inactive creation/opening and core runtime controls are available
through `pudl huddle` and MCP. Placement inspection and archive/unarchive also
share the ordinary session lifecycle; unarchive leaves the huddle stopped. **Edit with agent**
supplies a bundled huddle skill to a selected authoring account. Native provider,
supervisor and reboot acceptance is pending.
Application 28.10 adds **Active revision** for retained source/bindings and a
saved-versus-active comparison before **Apply saved**. The corresponding
`pudl huddle revision|diff` and MCP tools are documented in the
[authoring guide](huddle/authoring.md#review-active-source-and-saved-changes).

## Create and edit

Choose **New huddle** in the session tray, select a project worktree and create a
named huddle, or open an existing definition. Creation requires an installed
runtime with huddle support. Each huddle has its own random 32-character hex id:

```text
<worktree>/.puddle/huddle/<huddle_id>/
  huddle.json
  layout.json                 # optional, created when positions are saved
  nodes/
    <component>/
      node.json
      run.ts
      prompt.ts
```

Several huddles can live in the same worktree. The directory id is stable; the
display name can change. Source files are ordinary project files, suitable for Git
and agent editing. Runtime records are kept separately in private Puddle storage.

On application 28.27+, **Start from** also offers **Manual flow** and **Two-agent
review**. Manual flow wires Run → Transform → Result; Start it, then Run with any
JSON input. Two-agent review provides a coder, reviewer, approval condition and
five-round feedback loop. Select the coder and reviewer nodes and choose existing
agent sessions in the declared worktree before saving and starting. Missing agent
settings are intentional validation errors until configured. It allows ten turns
and forwards only approval to Result; exhaustion stays a visible failed limit.
Each starter includes editable scripts, layout, README and `fixtures/input.json`.
Creation starts no agent or huddle runtime.

On application 28.26+, **New huddle → Start from → Copy: …** copies a saved huddle
in the selected worktree. Enter a name, then choose **Copy saved huddle**. It gets
a fresh random id and a stopped placement; the original keeps its current lifecycle.
The copy includes saved scripts, layout, README, fixtures and unused components,
not unsaved editor drafts, run history, trigger cursors, private variable bindings
or secret grants. Literal worktree/account/session settings remain unchanged:
review them before Start. Copying requires ordinary UTF-8 source within the normal
file/bundle limits and rejects symlinks. If a reply fails, inspect Saved huddles
before trying again; the copy may already exist.

Use **Add node** to add Run, Result, a time trigger, an agent template or a local
contract path. Application 28.25 adds editable **Transform**, **Format text**,
**Condition**, **Merge** and **Join** nodes; see [data flow](huddle/flow.md).
Prompt and Review templates require application 28.3; Spawn requires 28.8.
Prompt spawned agent and Review spawned agent require 28.9.
They immediately publish editable source
files, then add a reference to the graph draft. **Undo** removes that reference;
it leaves the published files intact. After a failed reply, inspect the files
before creating another template. Template publication never overwrites edited
source; partial publication can leave unreferenced files.

Built-in node inspectors offer **View built-in source** and, on application 28.30+,
**Make local copy**. Copying creates editable `node.json`/`run.ts` files and changes
the same node's source in the draft, keeping settings, colour/icon and connections.
Save and Apply when ready. Undo restores the built-in reference and keeps the files.
Trigger copies require runtime `hostTriggerScripts: 1`. The host still observes
time, files, Git or agent events using its existing machinery; the editable script
receives each accepted event and controls what it emits. See
[local built-in adapters](huddle/authoring.md#local-built-in-adapters) for contracts.

Select a node to configure its parameters, colour and icon. **Open contract** and
**Open script** use the normal editor. The graph and **Open definition** share
the same manifest draft, undo history and save-conflict handling. Local contract
settings come from saved files. Save contract edits to update the inspector;
unsaved contract drafts are not used as execution contracts.

In a node's inspector, **Preview bindings** resolves its settings using sample
variables. Apply pending field edits first; the preview uses the current graph
draft, parameter defaults and declared variable types. It reports missing values
and type errors. Samples remain local and are not saved or reused for Start.
Worktree/session/account values are selectors until the host verifies them at
Start or Apply; **Active revision** shows the actual captured resource bindings.

On application 28.31+, **Validate** checks saved graph wiring, module syntax,
captured imports and wrapper contracts. Save source edits first to include them.
The dialog optionally accepts contract fixture paths, one per line relative to
this huddle's directory, and reports node/file errors for the checked revision.
Fixture samples check declared value contracts without running scripts or agents;
see [authoring validation](huddle/authoring.md#contract-fixtures).

On application 28.4, drag nodes with a mouse or touch, or focus a node and use
arrow keys (10 units, or 50 with Shift). Its inspector also offers X/Y position
fields. Escape or pointer cancellation abandons a drag. Drag the empty background
to pan, and use **Fit graph**, **Fit selected** or the zoom controls to navigate.
Large graphs draw nearby nodes and connections while retaining selected/focused
items and active gestures. **Node list** shows every node; choose one, switch back
to **Graph**, then **Fit selected** to reveal it. Crossing wires remain visible
even when their endpoint nodes are outside the pane.

Positions use a separate `layout.json` draft. **Undo move** / **Redo move** and
Cmd/Ctrl-Z while a node is focused operate on that layout history; the main
**Undo** / **Redo** controls operate on the graph definition. **Open layout** uses
the normal editor. Save or Cmd/Ctrl-S from the huddle saves both files, with separate
conflict checks; this is not a single atomic write. A missing layout is created
only on save, and a file created by someone else in the meantime causes a conflict.
Both drafts follow pane/window transfers and last-view close review. Camera,
node/connection selection and graph/list mode are private to each view. They survive
tab switching, close/reopen in the same pane, browser reload and pane/window handoff.
Two open views can navigate independently. Resizing or hiding a pane preserves
its desired canvas position; an invalid or obsolete saved view uses defaults.
Navigation never changes tracked source or starts a runtime. Browser state uses
bounded per-window storage; desktop views join the normal recovery snapshot.

For agent/tool authoring on host 28.11+, [captured source and guarded saves](huddle/source.md)
provide exact source text and a digest-checked publication of `huddle.json` or
`layout.json` through CLI/MCP. The IDE has not yet adopted that complete-capture
save contract; its existing per-file conflict checks remain in use.

Connect nodes by dragging an output socket onto an input, or click/focus the output
then click/press Enter on the input. Escape cancels. Compatible destinations are
highlighted; duplicate routes and definitely incompatible port types are refused.
Unknown type relationships remain checked against actual values at runtime. Select
a wire and choose **Disconnect selected**, or focus it and press Delete/Backspace.
The **Connections** inspector provides the same actions through labelled selectors
and includes feedback settings. Connections use the manifest's Undo/Redo history;
they do not send prompts or run nodes. A source edit during a wire gesture cancels
that gesture. Cycles can be drafted, but require explicit bounded feedback before
validation permits execution.

Use **Edit with agent** to give an explicitly selected account a task scoped to
this huddle's directory and worktree. Its ordinary session receives the bundled
authoring skill; it never activates edits automatically. See
[agent-assisted authoring](huddle/authoring.md) for account selection, source
review and lost-reply handling.

## Choose event admission

On host 28.29+ and runtime `admission: 1`, **Settings → Default event admission**
chooses the graph default. Each trigger's **Trigger admission** inspector can
override it and set its own queued-event limit. Save, then Start or Apply to
activate changes. Deleting a trigger removes its override; Undo restores both.

- **Queue** keeps every event until execution, within the graph and trigger bounds.
- **Coalesce waiting events** replaces the latest waiting input from the same
  trigger port and active revision/activation. Running work continues. If no such
  waiting input exists, the new event is queued normally.
- **Drop while busy** records a skipped event when that trigger already has
  pending/running work or a graph/trigger queue limit has been reached.

History shows policy decisions as cancelled executions with a reason; coalesced
entries identify their replacement execution. Original events remain retained,
and redelivery does not run them later. No running agent is interrupted. Queue or
coalesce refusal preserves the source cursor and waiting work; storage exhaustion
also refuses drops rather than silently discarding history. Superseded admissions
still count toward the daily execution limit. Dropped events do not, but still use
bounded history storage. Timer missed-occurrence policies below are separate.

## Run on an interval

Add **Interval**, connect its `event` output, and configure the interval in
milliseconds (1 second to 24 hours; default 1 minute). This is a fixed-duration
schedule, independent of timezones or daylight-saving rules. A huddle can have
at most 32 interval nodes.

The first occurrence is one interval after arming. **Start** and **Resume** arm
automatic triggers; **Apply** starts fresh schedules for the new revision when
armed. Interrupt/Stop disarm them, and paused time is not caught up on Resume.
Saving or opening a graph does not arm it. Closing the frontend or disconnecting
the daemon leaves a live independent owner's timer running.

Choose how a running owner's timer handles a delayed wake-up:

- **coalesce** (default): one event represents all due occurrences.
- **skip**: deliver the latest due occurrence and report how many older ones were skipped.
- **catch-up**: deliver up to the configured number of recent occurrences, in order;
  report older skipped occurrences in the first event. The default limit is 10, maximum 64.

Events contain `scheduledAt`, `firstScheduledAt`, `occurrences` and `skipped`.
Dates are UTC strings; the first date identifies the beginning of the covered gap.
Clock rollback never repeats an admitted occurrence. Clock changes are reconciled
when the owner next wakes; this is not a real-time scheduling guarantee.

Interval graphs require runtime capability `timers: 1`. Existing event-queue,
daily execution, worker and storage limits apply. The default daily execution cap
is 100; adjust `huddle.json` deliberately for your intended cadence. A missing
source, exhausted admission limit or persistence failure stops timer admission
and appears in runtime inspection. Inspect accepted executions, restore the
resource, then explicitly Stop/Start; failed occurrences are not silently consumed.
Explicit **Recover after reboot** restores retained timer progress and its configured
missed-event policy. Enable **Auto-start after reboot** to recover an armed run
when the host starts. Explicit owner-crash recovery is available on supporting
Linux cgroup-v2 runtimes. Application 28.19 also recovers armed supporting Linux
runs automatically, as described below.

## Run on a calendar or a one-off date

**Calendar** runs at a local `HH:mm` time on selected weekdays in an explicit
IANA timezone. Defaults are `09:00`, `UTC` and every day. Weekdays are a JSON list
from 1 (Monday) to 7 (Sunday), for example `[1,2,3,4,5]` for weekdays.
Nonexistent clock times during a daylight-saving gap are skipped. Repeated clock
times fire once, at the earlier occurrence. The owner uses its installed Node
runtime's timezone database; changing the computer's default timezone has no effect.

Calendar uses the same coalesce/skip/catch-up settings and event fields as Interval.
Counts include actual scheduled instants, excluding skipped civil times. Resume
starts from now and does not catch up paused time. It preserves the last admitted
instant if the clock moved backwards. A running owner's observation gap longer
than 366 days reports a fault instead of attempting unbounded catch-up. Inspect
accepted work and explicitly Stop/Start to start a new schedule from now.

On host 28.28+ with runtime `calendar: 2`, **Monthly / yearly** selects a day
of the month and a JSON **Months** list. Use `[1,2,3,4,5,6,7,8,9,10,11,12]` for
monthly, `[1,4,7,10]` for quarterly, or one month for yearly. **Day of month**
defaults to 1. Missing dates are skipped: day 31 skips shorter months, and
months `[2]` with day 29 fires only in leap years. A selection with no possible
date, such as February 30, fails activation. Timezone, local time, repeated/missing
clock times, missed-occurrence policy and Resume behavior match Calendar.
Its bounded month search covers nine years, including the eight-year leap-day gap
across 2100; larger observation gaps fail visibly. Old daily/weekly schedules
retain their 366-day observation bound.

**Date and time** takes an exact ISO timestamp with seconds and `Z` or an offset,
for example `2027-03-01T09:00:00+01:00`; optional milliseconds are supported.
Dates before 1970 are rejected. Choose what to do if the date is already past
when armed: **fire** (default) or **skip**. A future date that passes while the
running owner is asleep still fires once on waking. Once admitted or skipped,
it stays consumed through Interrupt/Resume and ledger reopening for that activation.

**Apply**, even for unchanged source, creates a new activation. **Start** after
Stop creates a new owner/activation. Both reset one-off consumption: a past date
set to **fire** may run again. Choose **skip** or change/remove the date when
that is not intended. Saving alone does not reset or execute anything.

Calendar and Date and time require runtime capability `calendar: 1` or `2`;
Monthly / yearly requires `2`. Old runtimes remain usable
for their supported graphs. Up to 32 calendar/date nodes can coexist with 32
interval nodes. All use one owner timer, existing execution/storage budgets and
explicit memory admission. Completed one-offs leave no idle timer. Closing the
frontend does not stop an armed owner. Host sleep/reboot and owner-crash recovery
still require separate native acceptance; retained state alone is not that promise.

## React to file changes

Add **Filetree**, choose an explicit project **Worktree**, and set **Directory**
to a relative directory (`.` means the worktree root). Include/exclude settings
are JSON lists of globs relative to that directory, for example `["**/*.ts"]`.
Hidden files need an explicit dot glob. `node_modules` is excluded by default;
Git metadata and every `.puddle/huddle` subtree are always excluded. Symlinks are
not followed. Declare the files/directories your graph writes in **Output paths**,
relative to the worktree, to exclude them and prevent self-triggering loops.

Start, Resume and armed Apply take a fresh baseline before completing their
arming response. Existing files and changes made while paused do not trigger runs.
A live owner watches directories, coalesces notifications within a debounce window
(default 250 ms), and reconciles a bounded metadata snapshot every 30 seconds.
Closing the frontend or losing the daemon controller does not stop observation.

An event contains up to 64 `changes`, each with a worktree-relative `path` and
`kind` (`create`, `change`, `remove`), plus `reconciled`, `observedAt`, `batch`
and `final`. More changes use ordered batches. They describe net observations,
not every intermediate edit: an atomic save is usually a change, and a rename
is remove/create. Metadata changes can trigger a change too. Empty directories,
symlinks and special files do not produce file events. File contents are not read.
There is no invented exact edit timestamp or claim of atomic filesystem snapshots.

The first release bounds each source to 128 directories, 8,192 scanned entries,
1,024 matched files, 256 KiB per snapshot and 256-character relative file paths.
There are at most eight sources per huddle. Narrow Directory and exclusions for
large trees; include filters alone do not prune directory traversal. Watch errors,
missing roots/source, scan timeouts and exhausted execution/storage limits report
an observation gap and stop automatic admission. Accepted batches remain retained;
inspect the failure, restore resources and explicitly Stop/Start to establish a
new baseline. Do not interpret that new baseline as replay of unobserved edits.

Filetree requires runtime capability `filetree: 1`. Native watcher behaviour
varies across filesystems; bounded rescans recover net changes from silent missed
notifications. Packaged supervisor/SSH/reboot acceptance remains unfinished.
Use **Triggers** to inspect installed source health and accepted backlog.

## React to Git changes

Add **Git**, select a project **Worktree**, and use **Repository directory** (`.`
by default) to choose an exact Git root inside it. **Ref globs** is a JSON list,
defaulting to `["refs/heads/**", "refs/tags/**"]`; `refs/remotes/**` is also supported.
**Observe worktree HEAD** includes branch switches and detached/unborn HEAD.
Use an empty ref list to observe only HEAD. Save, then explicitly Start or Apply.

Each event reports up to 64 changes with `ref`, `oldOid`, `newOid`, `oldTarget`
and `newTarget`, alongside the canonical `repository`, `observedAt`, `reconciled`,
`batch` and `final` fields. Missing values are null. Annotated tags use their tag
object IDs. A branch switch at the same commit is still a HEAD change. Force
updates are reported without assuming ancestry. Connect the event to a script
that filters the refs or formats an agent prompt.

Observation survives a disconnected frontend/controller. Shared repository refs
are read once per common directory; each explicitly configured node receives its
matching changes. The shortest Git-node debounce/reconcile settings in the huddle
control the shared scan (defaults: 250 ms and 30 seconds). Start, Resume and armed
Apply take a fresh baseline; paused activity does not replay. Net changes can miss
intermediate create/delete or move-back operations between observations.

The current limits are eight nodes, 4,096 refs per selected namespace group before
filtering, 1,024 matching refs plus HEAD per node, and 256 KiB per snapshot. Metadata
scans are bounded to 128 directories and 8,192 entries across the owner. Git/root
errors, timeouts and exhausted budgets stop automatic admission with a visible
failure; restore resources and explicitly Stop/Start for a new baseline. This
requires runtime `git: 1`. Packaged SSH/supervisor, reftable and full crash/reboot
acceptance remain pending.

## React to session lifecycle changes

Add **Session lifecycle**, choose an explicit **Worktree**, and optionally select a
**Session** in that project/worktree. An unset session observes all matching agents
or terminals there. Stopped and archived sessions are valid observation targets.
Use **Clear setting** to remove a selected session. **Session kinds** defaults to
`["agent"]`; choose `["terminal"]` or both to include terminals.

**Events** defaults to `["resumed", "exited", "archived"]`. Other choices are
`created`, `interrupted`, `killed`, `unarchived`, `spawn_failed` and `status`.
**Status transitions to** filters only `status` observations and defaults to all
statuses. An audit event and a status change can describe the same lifecycle action;
select the event family you need to avoid intentionally receiving both.

The event output includes `sequence`, `profileId`, `projectId`, `sessionId`,
`worktree`, `sessionKind`, `event`, `source`, `previousStatus`, `status` and
`observedAt`. Creation does not prove successful launch, and `waiting_input` does
not prove a completed agent turn. Use Prompt agent/Review agent outputs for the
implemented exact ask/reply workflow. Huddle sessions are excluded from this trigger.

Saving stays inactive. Start, Resume and armed Apply establish a fresh host cursor,
excluding prior or paused observations. A disconnected controller catches up from
the owner's retained cursor when it reconnects, within bounded host history; it does
not replay an already admitted page after a lost reply. Only recorded host transitions
are available: transitions that never reached the daemon are not reconstructed.
There are at most eight session nodes and 4,096 retained host sequence positions.
Unrelated activity can expire a cursor too. Retention loss, missing resources and
admission failure surface as an owner failure; inspect the cause and explicitly
Stop/Start to establish a new baseline. Use **Triggers** for installed source health and accepted backlog.
This node requires runtime capability `sessionEvents: 1`.

## React to an agent completing a turn

Add **Turn completed**, choose an explicit **Worktree** and a running **Agent**, and
connect its `event` output to a script or Result. The inspector explains the node's
behaviour. Saving a graph does not subscribe or start an agent.

**Start**, **Resume** and armed **Apply** establish a fresh baseline in the selected
agent's native history. Successful turns started outside automation after that
baseline emit their exact reply, native turn/conversation ids, session, runtime,
segment and worktree. Started, failed, interrupted, automated and unknown-origin
turns do not start graph executions. Use Prompt/Review result outputs for the
two-agent workflow below; those preserve the original execution's feedback limits.

The selected agent must already have a connected runtime and a bound native
conversation with exact turn observation support. Busy agents can be observed.
Runtime protocol 1.2 and provider availability are checked at arming; huddle owners
need `completionEvents: 1` and `completionPlans: 1`. Older runtimes still support
their existing sessions and graphs. No agent is prompted or restarted to enable a
subscription, and a huddle supports at most eight completion sources.

A frontend disconnect does not stop observation. While the daemon is disconnected,
the agent runtime retains bounded observations; reconnection catches up from the
huddle's saved cursor. A missed reply to delivery does not repeat an admitted
execution. Native history retains at most 128 records and 2 MiB, so sufficiently
long disconnections can produce an explicit gap. Conversation/runtime replacement
and history gaps stop the subscription visibly instead of following another agent
or skipping unseen replies. Inspect the failure and explicitly re-arm when ready
to accept a fresh baseline. Resume excludes turns completed during interruption.

## Use native completion in a two-agent conversation

On application 28.20 with a runtime advertising `nativeFeedback: 1`, add **Prompt
agent with native completion** or **Review agent with native completion**. Add a
**Turn completed** source for each selected agent and choose that node in the new
**Completion trigger** setting. The source and script must select the same existing
agent and explicit worktree. A variable may supply the source node id.

Wire the script's `completed` output into the ordinary bounded feedback workflow.
The script calls `agent.askNative()` and continues once its ask result and exact
native completion agree. It uses one execution and the same turn/round/time limits;
the matching automated event does not also fire the trigger's `event` output.
The trigger can still admit external human turns through that output if connected.

This uses Puddle's existing turn observation and session lifecycle. It requires an
already bound native conversation; it does not create or restart an agent to obtain
one. A source gap, takeover, subscription replacement or interruption ends the wait
without retrying the prompt. Saving nodes remains inactive until Start/Apply.

## Prompt existing agents

**Prompt agent** sends a prompt to an existing live agent and returns its text.
**Review agent** requests a strict object with `complete: boolean` and
`feedback: string`. Each template exposes these settings:

| Setting | Value |
| --- | --- |
| Worktree | An explicit registered project worktree, or a worktree variable. |
| Agent session | A live agent placement in the same project and declared worktree, or a session variable. |
| Prompt | Text containing `{{input}}` or a field path such as `{{input.feedback}}`. |

Each node can choose a different registered worktree. Selecting a session uses
that agent's existing account and conversation; these templates do not launch or
restart agents. Start/Apply resolves an exact live runtime and incarnation. A busy
agent may be selected but rejects a concurrent ask; a replacement agent requires
fresh activation bindings.

The incoming value reaches the `value` port. Prompt substitution preserves strings
and JSON-encodes other values; a missing field or expansion above 128 KiB fails
before sending a prompt. Field
paths traverse own properties only and do not evaluate expressions. Format or
transform more complex inputs in the editable script.

The `completed` output fires when the node returns. The optional `turn` event
output emits the reply immediately after the ask completes. Connecting both ports
creates separate deliveries, so use the output appropriate to the workflow.

## Spawn an agent

On application 28.8, add **Spawn agent** and connect an upstream value to its
`value` input. Choose the current project, a registered worktree, a provider and
an account explicitly. Provider choices support scripted turns; account choices
are logged-in accounts in the current profile matching the chosen provider.
Changing the provider preserves an incompatible saved account as **unavailable**
until you change it. Resources may also be supplied by declared variables.
Start/Apply rechecks all choices; no default account is substituted.

Choose **interactive** or **headless** mode, a session title and a prompt using
`{{input}}` or its fields. Visible defaults are interactive mode, “Huddle agent”
and `{{input}}`. Invalid prompt substitution fails before creating an agent.
The node creates one agent, sends the prompt, then returns `completed` (reply text)
and `agent` (`{runtime_id, session_id}`). Its optional `turn` port emits that reply.
The files are ordinary editable `node.json`, `run.ts` and `prompt.ts` source.

Spawn graphs require runtime `spawns: 1` and `operations: 2`. Older runtimes still
support their existing sessions and graphs; unsupported Start/Apply is rejected.
Installing a newer runtime does not restart existing owners.

Custom downstream scripts in the same execution can call
`puddlang.attach(inputs.agent.runtime_id)` with an explicit matching worktree
binding. **Prompt spawned agent** and **Review spawned agent** expose a required
`agent` input for this handle; choose an explicit matching worktree and prompt.
The original Prompt/Review templates continue to select existing sessions.
A later execution must bind the retained session explicitly. Keep Spawn outside a feedback loop unless each iteration is
intended to create another agent; normal spawn budgets apply.

Successful executions keep their agents available. With the default
`execution.cleanup: "stop-owned"`, execution failure/deadline cleans up that
execution's agents, and Interrupt/Stop cleans up agents from all executions.
Stop waits for exact exit evidence; uncertain cleanup remains visible.
Set `execution.cleanup: "retain-owned"` in `huddle.json` to leave those agents
running when the execution ends or the huddle is interrupted/stopped. You then
manage their lifecycle through ordinary session controls. The policy is captured
per execution, so Apply cannot change an earlier execution's policy. Retention
does not restart interrupted node scripts or grant permission to replay an
uncertain spawn. Attached existing agents retain their own lifecycle rules.

## Two agents exchanging replies

Add Run, Prompt agent, Review agent and Result. Bind the two agent nodes to their
worktrees and live sessions. In **Connections**, create:

```text
run.event → prompt-agent.value
prompt-agent.completed → review-agent.value
review-agent.completed → result.value
review-agent.completed → prompt-agent.value   [bounded feedback]
```

On the last connection, enable **Bounded feedback**, select `complete`, continue
while **False**, and choose a finite maximum round count. Keep the coder's prompt
able to accept both the initial Run value and the review object, for example:

```text
Implement the requested changes. The input may be an initial task or review feedback:
{{input}}
```

The reviewer template includes instructions to return `complete: true` only when
no further changes are needed. Approval stops the feedback route. Exhausting the
round limit fails the execution; it does not count as approval. The initial pass
counts as round one. Other graph/turn/time budgets still apply.

A direct cycle without an explicit bounded feedback edge is invalid. Two agents
can talk to each other through the feedback route; removing all feedback edges
must leave an acyclic graph.

## Create two agents and reuse them in feedback

On application 28.9, add two Spawn agent nodes, Prompt spawned agent, Review
spawned agent and Result. Give each Spawn explicit resources and an initial prompt.
Name them `spawn-coder` and `spawn-reviewer`; select the matching worktree on each
subsequent prompt/review node. Connect:

```text
run.event → spawn-coder.value
spawn-coder.completed → spawn-reviewer.value
spawn-coder.agent → coder.agent
spawn-reviewer.agent → reviewer.agent
spawn-reviewer.completed → coder.value
coder.completed → reviewer.value
reviewer.completed → result.value
reviewer.completed → coder.value   [bounded feedback]
```

Here `coder` uses Prompt spawned agent and `reviewer` uses Review spawned agent.
Both Spawn nodes perform their configured initial prompts. Choose these prompts
and the later prompts so the initial task and replies carry the context you want.
The reviewer returns `{complete, feedback}`. Configure the feedback edge to
continue while `complete` is false with a finite round limit, as above.

Each `agent` input is retained for **one execution**, including feedback rounds.
Connect it once. A second delivery to that input is an error, even if it repeats
the same handle; replay of the exact original delivery is deduplicated. Incoming
`value` messages still require their own matching activation. Handles arriving
before or after a value work, and different executions cannot share these inputs.
The inspector explains retained inputs; custom contracts declare them with
`"scope": "execution"`. They must be required inputs on an `all` node with at least
one normal required input. They cannot be feedback destinations or output scopes.

This requires runtime `executionInputs: 1` in addition to spawning/agent-operation
support. A handle still must belong to this execution and match the declared
worktree. The graph does not follow a replacement runtime. The two Spawn nodes
remain outside feedback, so repeated review rounds reuse those two conversations.
Their initial prompts also consume the shared turn budget. Cleanup follows each
execution's captured policy described above.

## Save, activate and run

Saving changes files. It does not activate code or send agent messages. Use
**Start** for a stopped huddle or **Apply** for an existing owner to capture saved
source and resource bindings. Agent graphs require runtime operation capability 2.
Review variables and activation details. Start arms automatic triggers; use **Run** to supply JSON input to
the manual trigger. Running executions retain their accepted source revision.

Inspect execution history for results and failures. **Interrupt** stops new work
and requests cancellation of admitted turns; **Resume** rearms the existing
activation. **Stop** ends the huddle owner. Closing its pane only closes the view.
After a failed command reply, inspect runtime/history before another action;
reconnect never automatically resends a command. Owner crash recovery and reboot
continuity have additional pending acceptance gates described in the acceptance
document.

## Recover after a reboot

On a host supporting application 28.15 and runtime `recovery: 1`, open an unresolved
huddle and choose **Recover after reboot**. Puddle restores its last active graph,
queued events and trigger cursors in one new owner. Saving source edits does not
change the graph being recovered. This action may resume armed triggers and queued
work. A stopped/interrupted graph keeps that intent.

Completed work is preserved. Scripts that were running are marked interrupted;
uncertain prompts, spawns and lifecycle changes are observed using their original
identities and are never automatically sent again. History remains available.
Recovery requires a verified host reboot; it currently rejects an owner crash on
the same boot. Replaced agents or unavailable
resources remain explicit errors/gaps; inspect them before rearming or applying
new bindings. After a failed recovery reply, inspect the runtime and history.
Do not repeat the command or substitute a newer target automatically.

CLI: inspect `pudl huddle runtime SESSION_ID`, then pass its `recovery.owner` as
`pudl huddle recover SESSION_ID --request '{"owner": {"runtimeId": "…", "incarnation": "…"}}'`.
The `huddle_recover` MCP tool takes the same owner with `session_id` and `request`.

## Start an armed huddle automatically after reboot

On application 28.16 and runtime `autoStart: 1`, enable **Auto-start after reboot**
next to the execution controls. It defaults off for a new run. Changing it does
not reset schedules, move trigger cursors or arm a stopped graph. Apply and
Interrupt/Resume preserve the preference; a fresh Start after Stop defaults off.

When the daemon starts after a verified host reboot, it restores opted-in runs
whose last intent was armed. Stopped/interrupted runs and archived huddles/projects
stay inactive, even if the preference was enabled. Normal daemon replacement on
the same boot reconnects to surviving runtimes. An uncertain accepted launch is
not attempted again. Missing resources and unsupported installed runtimes leave
the huddle available for inspection and explicit recovery. This setting does not
change ordinary agents' auto-resume configuration or install a host startup service.

For CLI/MCP, inspect runtime with a supporting client, then send
`{target, expected: false, enabled: true}` to `pudl huddle auto-start SESSION_ID --request JSON`
or `huddle_auto_start`. Use the actual inspected `auto_start` value for `expected`.
After a lost reply, inspect the setting before another explicit action.

## Inspect trigger health and backlog

On application 28.17 and a supporting owner, open **Triggers** from the execution
tray. It lists every active-definition trigger, its installed health, accepted
queued/running work and last event time. Interval and calendar sources show their
next deadline, missed-event policy and retained combined/skipped occurrences;
one-off dates show whether they are pending, admitted or skipped.

The top backlog includes older activations still in flight. Individual source
counts cover the inspected activation. An empty queue does not prove an external
source is healthy, and Ready means installed rather than a live service probe.
Inspect a reported gap before explicitly restoring/restarting its subscription.
The panel refreshes only while open and focused; after Apply or a lifecycle change,
close and reopen it for the current activation.

Agents can read the same report with `pudl huddle triggers SESSION_ID --request JSON`
or `huddle_triggers`, supplying `{target}` from runtime inspection. These reads
never start work, reset cursors or reopen a subscription.

## Recover after an owner crash on Linux

With application 28.18 and a supporting systemd/cgroup-v2 runtime, **Recover after
crash** appears when the recorded owner has matching retained containment metadata.
Recovery requires positive evidence that its script descendants have ended. It
restores the active graph, queued events and trigger cursors through the existing
recovery path. In-flight scripts stay interrupted; uncertain agent operations are
observed, never dispatched again.

The offer alone does not prove descendants have exited. A rejected or lost reply
requires inspecting runtime/history before another action. Recovery does not kill
unconfirmed processes. Older runtimes, macOS and detached lifetimes retain **Recover
after reboot**. Supporting Linux runs can also recover automatically as described below.

CLI/MCP use the existing recovery command with
`{owner: {runtimeId, incarnation}, after: "owner-crash"}`. Omitting `after` keeps
reboot-only behavior. Both the original owner and selected replacement runtime must
support this path; no project code or session lifecycle implementation is duplicated.

## Automatic recovery of armed Linux huddles

Application 28.19 and runtimes advertising `automaticRecovery: 1` recover an armed
huddle after authoritative owner-loss reconciliation and positive descendant-exit
checks. This applies to supporting Linux systemd/cgroup-v2 owners; older owners,
macOS and detached runtimes keep their existing recovery paths.

Stop, Interrupt and Archive suppress automatic recovery. The separate **Auto-start
after reboot** preference still controls reboot recovery. Queued roots and trigger
cursors survive; running scripts are interrupted and accepted agent actions are not
repeated. Recovery waits for host admission and pauses during daemon maintenance.

At most three automatic replacements occur between explicit/reboot recoveries or a fresh
Start. If the huddle keeps crashing, inspect its retained history and source before
using **Recover after crash** explicitly. Applying source alone does not reset this
limit. A lost recovery reply cannot trigger a second replacement for the same owner.
