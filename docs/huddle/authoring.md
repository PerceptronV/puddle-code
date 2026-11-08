# Edit a huddle with an agent

Open the huddle and choose **Edit with agent**. Select an account and describe the
change. **Start authoring agent** creates an ordinary coding session in the exact
project worktree shown in the dialog, then opens its session tab. The initial
prompt supplies the huddle id, directory, worktree, project/profile, connected
application protocol and bundled huddle authoring skill.

The account choice starts empty. Available choices belong to the current profile;
logged-out accounts cannot be selected. Removing or logging out the selected
account does not select another one. **Refresh accounts** reloads the list. Normal
session creation still checks the chosen account, provider availability and
worktree on the host. This ordinary authoring session does not require a provider's
scripted-turn support; that requirement applies to agents invoked by graph nodes.
Permission bypass is disabled for authoring launches.

Save or resolve open huddle source drafts before starting the agent. This includes
the manifest, layout and open component files in this huddle's editor context.
Do not edit the same files concurrently without reviewing the normal source
conflicts. The agent shares this worktree; it does not receive a new branch or
worktree, and its ability to edit files is the normal coding agent's ability,
not a filesystem sandbox restricted to the huddle directory.

The bundled [puddle-huddle skill](../../packages/web/src/features/huddle/authoring/skill/puddle-huddle/SKILL.md)
is embedded in the initial prompt by the frontend. It is not installed into the
account's personal skill directory and does not depend on provider-specific skill
discovery. It explains source layout, input/output contracts, explicit worktrees,
bounded feedback, captured revisions and uncertain operation outcomes. Existing
session onboarding/concurrent-worktree instructions still apply. No automatic
nested delegation or graph execution is requested.

After the agent edits files, return to the huddle and inspect the source changes
and diagnostics. Use **Refresh** for a fresh saved-definition inspection. Ordinary
editor buffers observe file changes and retain their save/conflict behaviour.
Saving a file or finishing the authoring turn does not activate the edits. Use the
separate **Start** or **Apply saved** review when ready; these can arm automatic
triggers. **Run** sends manual input separately.

Creation is attempted once per open authoring dialog. If the reply is lost, a
session may already exist: close the dialog and inspect the session list before
starting again. Reconnect never automatically retries creation. The authoring
agent has its own normal session lifecycle; stopping the huddle does not stop that
ordinary coding session.

## Inspect and validate from the CLI or MCP

The CLI ships `pudl huddle list`, `inspect` and `validate`. Use `pudl context` to
find project ids, then supply the exact registered worktree on the selected host.
For example, replacing these sample ids and paths with your own:

```sh
pudl huddle list --profile work --project 0123456789 --worktree /srv/app
pudl huddle inspect 0123456789abcdef0123456789abcdef \
  --profile work --project 0123456789 --worktree /srv/app
pudl huddle validate 0123456789abcdef0123456789abcdef \
  --profile work --project 0123456789 --worktree /srv/app
```

Add `--host user@host` for SSH. Paths always belong to that host; the CLI never
infers a worktree from its own cwd or uploads local files. Existing local/SSH
authority and profile selection apply. A current compatible running daemon is
required, but source inspection needs no huddle placement, supporting runtime or
logged-in agent. It never opens a session or evaluates component modules.

`list` returns JSON discoveries, including errors for unreadable/invalid huddles.
`inspect` returns the captured definition, component contracts, optional layout,
source digest and diagnostics. `validate` returns `{valid, digest, diagnostics}`
and exits 1 when an error diagnostic exists; warnings alone exit 0. Diagnostics
retain their stable codes and node/edge/path locations. Invalid/unreadable root
manifests and connection/authority failures report an error on stderr and exit 1;
they do not return a successful validation report. No automatic retry occurs.

Validation checks captured JSON contracts and graph structure. It does not
type-check or execute TypeScript, test external integrations, check provider
availability or resolve live execution resources. `valid: true` is not permission
or proof of readiness to run. Start/Apply still perform their own admission against
the reviewed source digest and current resources.

`pudl mcp` exposes `huddle_list`, `huddle_inspect` and `huddle_validate` alongside
the existing programme tools. Their strict arguments are `project_id`, absolute
`worktree` and, for inspect/validate, `huddle_id`. They share the connection's
profile; arguments cannot substitute a host/profile or request activation. Tools
are advertised only on a supporting connection. Validation errors appear in the
normal report with `valid: false`; malformed calls and unavailable source are MCP
tool errors. This does not automatically configure MCP for authoring accounts.

For custom extensions, see [triggers](triggers.md) and [readouts](readouts.md).
Standalone JSON Schema/type bundles, component fixtures and graph diff
remain pending. The originally proposed directory-only validation command is superseded by the explicit scope above.

## Create, open and control a huddle

`pudl huddle create --name NAME --project ID --worktree ABSOLUTE_ROOT` creates
a blank graph and inactive session. `pudl huddle open HUDDLE_ID --project ID
--worktree ABSOLUTE_ROOT` opens saved source or returns its existing placement.
Both return JSON including `session.id`. Creation requires an installed supporting
runtime; neither command launches one. Open does not resume or unarchive a huddle.
After a lost create reply, use `list` before creating again.

The directory's 32-character **huddle id** and the placement's UUID **session id**
are distinct. Runtime controls take the session id; its immutable placement binds
the project and worktree. They reject `--project`/`--worktree` flags rather than
silently ignoring a conflicting scope.

```text
pudl huddle runtime SESSION_ID
pudl huddle start SESSION_ID --request JSON
pudl huddle apply SESSION_ID --request JSON
pudl huddle run SESSION_ID --request JSON
pudl huddle interrupt SESSION_ID --request JSON
pudl huddle resume SESSION_ID --request JSON
pudl huddle stop SESSION_ID --request JSON
pudl huddle history SESSION_ID --request JSON
pudl huddle observe-readout SESSION_ID --request JSON
```

Every command accepts the same `--host`/`--profile` connection selection. Runtime
controls require application 28.2; readout observation requires 28.6 and a capable
owner. Runtime inspection opts into readout support and custom-trigger health
only when the connected host supports those fields (28.6/28.7).

`--request` is the JSON request body, with these required fields:

| Command | Required request fields |
| --- | --- |
| `start` | `expected_digest` from source inspection; explicit `variables` object |
| `apply` | `expected_digest`, `variables`, and exact `target` |
| `run` | `target`, manual-trigger `node`, caller-chosen UUID `event_id`, explicit JSON `data` |
| `interrupt`, `resume`, `stop` | `target` |
| `history` | `owner`, `collection`, nonnegative `after`; execution `parent` for invocations, invocation `parent` for operations |
| `observe-readout` | `target`, `operation_id` |

Use `owner.target` from a connected runtime inspection **verbatim** as `target`:
it contains `runtimeId`, `incarnation`, `generation` and `activationId`. History's
`owner` contains only `runtimeId` and `incarnation`. History returns one bounded
page and its `next` cursor; it currently needs a connected owner. Optional history
`include_readout_observation: true` requires 28.6. Do not replace a failed target
with a newer one automatically.

Start and Apply consume the explicitly reviewed saved digest and variables; they
do not save drafts. Start and Resume arm triggers, and Apply can reset armed
triggers. These actions can execute trusted code immediately. Resume rearms the
existing activation; it does not restart agent sessions or continue interrupted
scripts. Run's reply acknowledges input and gives an execution id, not a completed
result. Interrupt/Stop follow the execution's captured agent cleanup policy.
Readout observation may contact an integration but does not redeliver its action.

After a failed mutation reply, inspect runtime/history before deciding what to do
next. A request may have been accepted even when its response was lost or malformed.
The tools never retry, generate substitute event ids, refresh a target or fall
back to another action. A source validation result or authoring agent's completion
does not itself authorise execution.

MCP adds `huddle_create`, `huddle_open`, `huddle_runtime`, `huddle_start`,
`huddle_apply`, `huddle_run`, `huddle_interrupt`, `huddle_resume`, `huddle_stop`,
`huddle_history`, and `huddle_observe_readout`. Create/open use the source scope
fields above, with `name` for create. Runtime takes `{session_id}`; other runtime
tools take `{session_id, request}` with the same body as the CLI. Capability gates
filter the advertised tools; mutation annotations identify their effects and do
not promise safe replay. There is no automatic MCP installation or execution
approval on behalf of authoring agents.

## Inspect, archive and restore a placement

```sh
pudl huddle session SESSION_ID
pudl huddle archive SESSION_ID
pudl huddle unarchive SESSION_ID
```

These commands require a compatible application 28.2+ host and accept the usual
`--host`/`--profile` selection. They take the placement UUID returned by `open`,
with no `--request`, project or worktree override. The host verifies that this is
a huddle in the selected profile before the tools use normal session routes.
`session` returns its declared project/worktree and current archive status.

Archive follows the sidebar action: stop the placement's **current owner**, apply
its captured agent cleanup policy and then hide the session. Uncertain shutdown
cannot be reported as successful archive. Source, worktree and retained history
are preserved. Unlike `stop --request`, archive is a placement operation and does
not require a previously inspected owner target. Unarchive returns the placement
to `exited` without starting an owner, arming triggers, recreating a missing worktree
or unarchiving the project. Start remains a separate explicit action.

MCP equivalents are `huddle_session`, `huddle_archive` and `huddle_unarchive`, each
with strict `{session_id}` arguments. Only `huddle_session` is read-only. After a
failed archive/unarchive reply, use `session` and `runtime` to inspect what happened
before deciding on another action; the tools never retry or fall back automatically.
