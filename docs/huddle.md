# Huddles: current usage

Huddles are project orchestration graphs powered by puddlang. This guide describes
the implemented local/SSH workflow. The [roadmap](roadmap/huddle.md) covers the full
design; [acceptance](acceptance/huddle.md) records verified behaviour and remaining
work. Interval, calendar and one-off date triggers are available on supporting
runtimes. Filetree, Git, session lifecycle/status and exact external turn-completion
observation are also available. [Custom readouts](huddle/readouts.md) can deliver
graph outputs to external services on supporting runtimes. [Custom triggers](huddle/triggers.md)
can subscribe to external sources with durable cursors and visible source health.
Spawn agent creates an agent and sends its initial prompt. Resume/restart nodes,
explicit native feedback and authoring CLI/skills remain unfinished. Native provider, supervisor and reboot acceptance is pending.

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

Use **Add node** to add Run, Result, a time trigger, an agent template or a local
contract path.
Prompt and Review templates require application 28.3; Spawn requires 28.8.
They immediately publish editable source
files, then add a reference to the graph draft. **Undo** removes that reference;
it leaves the published files intact. After a failed reply, inspect the files
before creating another template. Template publication never overwrites edited
source; partial publication can leave unreferenced files.

Select a node to configure its parameters, colour and icon. **Open contract** and
**Open script** use the normal editor. The graph and **Open definition** share
the same manifest draft, undo history and save-conflict handling. Local contract
settings come from saved files. Save contract edits to update the inspector;
unsaved contract drafts are not used as execution contracts.

On application 28.4, drag nodes with a mouse or touch, or focus a node and use
arrow keys (10 units, or 50 with Shift). Its inspector also offers X/Y position
fields. Escape or pointer cancellation abandons a drag. Drag the empty background
to pan, and use **Fit graph**, **Fit selected** or the zoom controls to navigate.

Positions use a separate `layout.json` draft. **Undo move** / **Redo move** and
Cmd/Ctrl-Z while a node is focused operate on that layout history; the main
**Undo** / **Redo** controls operate on the graph definition. **Open layout** uses
the normal editor. Save or Cmd/Ctrl-S from the huddle saves both files, with separate
conflict checks; this is not a single atomic write. A missing layout is created
only on save, and a file created by someone else in the meantime causes a conflict.
Both drafts follow pane/window transfers and last-view close review. Camera and
selection persistence remain unfinished.

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
Retained timer state does not yet establish automatic owner-crash or reboot recovery.

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

These nodes require runtime capability `calendar: 1`; old runtimes remain usable
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
notifications. Packaged supervisor/SSH/reboot recovery and a richer per-trigger
health/backlog inspector remain unfinished.

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
Stop/Start to establish a new baseline. Richer source health remains unfinished.
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
binding. The shipped Prompt/Review templates currently select existing sessions;
they do not yet accept dynamic handles. A later execution must bind the retained
session explicitly. Keep Spawn outside a feedback loop unless each iteration is
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
