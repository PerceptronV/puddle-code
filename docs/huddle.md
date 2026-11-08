# Huddles: current usage

Huddles are project orchestration graphs powered by puddlang. This guide describes
the implemented local/SSH workflow. The [roadmap](roadmap/huddle.md) covers the full
design; [acceptance](acceptance/huddle.md) records verified behaviour and remaining
work. Interval, calendar and one-off date triggers are available on supporting
runtimes. File/Git/session subscriptions, agent spawn/resume nodes and authoring CLI/skills
remain unfinished. Native provider, supervisor and reboot acceptance is pending.

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
Agent templates require application 28.3. They immediately publish editable source
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
