# Edit a huddle with an agent

## Packaged authoring kit

`pudl huddle authoring` lists bundled schemas, TypeScript declarations, editable
script/trigger/readout templates, two example graphs and fake integration fixtures.
Read one exact listed path with `pudl huddle authoring README.md` or
`pudl huddle authoring types/puddlang-huddle.d.ts`. Output is JSON: the listing has
`files: [{path, bytes}]`; a selected asset has `path` and `content`. Both include
`format`, `application` and `source: "bundled-client"`. Extract `content` to a file
only when you intend to add it to your project. No asset command writes files.

This command needs no running daemon and accepts no host/profile/project/worktree
options. Matching MCP tool `huddle_authoring` takes `{}` or `{path}` and reads the
same client-bundled kit on an existing MCP connection. The reported application
version identifies the kit, not the target host's capabilities. Read that host's
metadata and validate the saved graph there before execution.

Keep the four `schemas/` files together and associate them through editor settings;
format-1 documents reject an inline `$schema` field. The schemas describe structure,
not runtime cross-field/path/byte limits, binding or graph validation. Include
`types/puddlang-huddle.d.ts` in a strict TypeScript project with ES2023/DOM libraries
and zod 4 as a development dependency. Worker imports still use pinned helpers;
do not install a runtime package named puddlang. Maintainers regenerate declarations
with `node scripts/build-huddle-types.mjs`; `--check` detects stale generated output.

Copy relevant `templates/` directories to the selected huddle's `nodes/` paths.
The manual example needs only the transform; the feed/report example needs all
three components and explicit endpoint variables. Replace fixture graph ids with
the selected huddle id. Create new ids with the normal huddle creation command.
The feed assumes a bounded cursor API; the report requires an explicit confirmed
receipt and treats missing/invalid replies as unknown. Adapt these assumptions to
the real service before activation. Fake fixtures exercise contracts, not live
integration behavior. The kit includes no credentials; authenticated services can
use [private host secret references](integrations.md).

## Account-selected editing

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

The kit also includes `templates/file-report/{node.json,run.ts,file.ts}`, the same
editable Write report component offered by Add node on application 28.22+. Copy
all three files together, select an explicit worktree, and configure the report
path and text/JSON format. Install `@types/node` for Node 22 in the authoring
project and enable `allowImportingTsExtensions` for no-emit checks. See
[Write report](readouts.md#write-report) for conflict and observation behavior.

For authenticated integrations, use [private host secret references](integrations.md)
(application 28.23, runtime `integrationSecrets: 1`). Graph files contain logical
references; adapters receive the value in `context.secrets` by parameter name.
Never ask an authoring agent to put credentials in source or prompts.

For custom extensions, see [triggers](triggers.md) and [readouts](readouts.md).
Standalone JSON Schema/type bundles and component fixtures remain pending. The originally proposed directory-only validation command is superseded by the explicit scope above.

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
| `history` | `owner`, `collection`, nonnegative `after`; execution `parent` for invocations and operations |
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


## Review active source and saved changes

On application 28.10+, `pudl huddle revision SESSION_ID --request JSON` inspects
the connected owner's retained revision. Supply `{ "target": ... }` using
`runtime`'s exact `owner.target`. The reply contains actual variables, resolved
node bindings, worktree and application time, plus the captured source/contract
inventory. This works even if the project definition has been deleted.

`pudl huddle diff SESSION_ID --request JSON` compares that activation with saved
source. Supply the same `target` and `expected_digest` from source `inspect`.
The inventory marks each entry `added`, `removed`, `modified` or `unchanged` and
includes SHA-256 hashes and UTF-8 byte counts for each present side. Retained-only
inspection marks entries `retained`. Layout and scripts are included; contracts
also appear by node id so resolved built-in changes are visible.

To read one entry, add `"entry": {"kind": "file", "path": "huddle.json"}` or
`"entry": {"kind": "component", "path": "NODE_ID"}` to the same request.
`content.before` is active text; `content.after` is saved text for diff, with null
for an absent side. Source text is exact; resolved contracts use canonical JSON.
No component module is imported. Stale source/activation requests fail; review
again explicitly rather than silently replacing the digest or target.
MCP equivalents are `huddle_revision` and `huddle_diff`, with strict
`{session_id, request}` arguments and read-only annotations.

The IDE exposes **Active revision** independently of editable source. On supporting
hosts, **Apply saved** shows the same comparison and seeds variables from the
actual activation. File/contract selection opens a read-only Monaco comparison.
The subsequent Apply still requires the reviewed target and saved digest; viewing
the comparison does not apply it. Unsaved edits are excluded. Older hosts retain
the existing Apply controls without comparison. These observations currently
require a connected owner; offline/stopped-owner review remains unfinished.


## History after an owner stops

On a supporting local/SSH daemon (application 28.12+), list the huddle placement's
recorded runtimes with:

```sh
pudl huddle history-owners SESSION_ID --request '{}'
```

Use its returned `owner` identity in an explicit request to
`pudl huddle retained-history SESSION_ID --request JSON`. Supply `collection`,
`after: 0` initially, and the execution UUID as `parent` for node/operation pages.
Use the returned cursor for subsequent pages. MCP names are
`huddle_history_owners` and `huddle_retained_history`, each taking
`{session_id, request}`. Neither needs project source or a running huddle. The
host daemon must remain available; these are not client-side offline caches.

Results are labelled recorded evidence. A last-recorded `running` execution may
have lost its owner, and an `unknown` external operation is still unknown. Reads
never restart work, retry operations or reconcile readouts. Missing, unsupported
or concurrently changing private state produces an error without a live fallback.

The IDE's **History** action opens the recorded runtime list after Stop. From a
live history view, choose **Recorded runtimes** to inspect earlier owners. Choose
an execution to see nodes, results and operation outcomes. Recorded pages show
the read time and refresh only explicitly; they offer no readout observation
controls and do not resolve an uncertain-command warning.

### Source after an owner stops

On daemon 28.13+, use an exact owner from `history-owners` with
`pudl huddle retained-revision SESSION_ID --request JSON` or read-only MCP
`huddle_retained_revision` (`{session_id, request}`). For example:

```json
{
  "owner": {"runtimeId": "<recorded-runtime-uuid>", "incarnation": "<recorded-incarnation-uuid>"},
  "entry": {"kind": "file", "path": "huddle.json"}
}
```

Omit `revision` to inspect the last recorded activation and its variables/resolved
bindings. Add `revision` from an execution record to inspect that exact source;
this returns no activation settings, because a source digest can have been applied
with different settings. Add `expected_digest` from current saved-source inspection
to compare the retained files/contracts with that exact saved capture. A stale
saved digest fails; inspect and review before making another request. Omit `entry`
for an inventory, or use `kind: "component"` for a resolved node contract.

The IDE exposes **Recorded activation** in History and **Execution source** on an
execution. These reuse the read-only source viewer and work after Stop or project
source removal while the supporting daemon is reachable. They do not restart the
runtime, execute code or provide Apply authority. Entry reads pin the returned
revision. Retained source can be unavailable after deletion or corruption of its
private runtime data; inspection does not recreate or repair it.


## Resume and restart an existing agent

On application 28.14 and a runtime advertising `lifecycle: 1`, Add node includes
**Resume agent** and **Restart agent**. Choose an explicit worktree and session,
then configure the prompt (`{{input}}` and `{{input.field}}` substitutions work as
for Prompt agent). Resume lists stopped sessions; Restart lists live agents.
Both require a known native conversation and use the session's existing account,
provider, permissions and mode through Puddle's ordinary session controls.

The editable contract declares `"lifecycle": "resume"` or `"lifecycle": "restart"`.
Its script calls `puddlang.resume(bindings.agent)` or
`puddlang.restart(bindings.agent)` and receives an agent handle for the existing
`ask()` API. The templates send the configured prompt and expose `agent`,
`completed` and turn-event outputs. Returned handles may feed subsequent nodes
in the same execution with the same declared worktree. These agents remain under
ordinary session ownership; huddle Stop does not clean them up as new spawns.

Saving stays inactive. Start/Apply captures the conversation and, for Restart,
the exact current runtime. Declaring and activating a Restart node authorises
stopping that runtime and its terminals using the current installed runtime
selection. Before dispatch, Puddle records the runtime inspection and impact
fingerprint, then its normal restart service rechecks that fingerprint. Terminal
process state is lost. A replaced runtime or changed conversation requires a fresh
Apply; the node never follows a replacement or restarts after a generic prompt
failure. A lost reply is observed through retained operation history and cannot
cause another resume/restart. If dispatch was interrupted before a replacement
was recorded, inspect the ordinary session before taking a new explicit action.


## Native-confirmed asks

Application 28.20 and owner capability `nativeFeedback: 1` add editable templates
`native-prompt-agent` and `native-review-agent`. They use the ordinary agent bindings,
worktree and prompt settings, plus a `completion` parameter selecting a Turn
completed node id. Their manifests declare `"nativeCompletion": "completion"`.
The selected trigger must already observe the exact bound agent/conversation.

Custom scripts can use `await agent.askNative(prompt)` or the same structured
`{ prompt, input?, schema }` overload as `ask()`. Declare sessions capability, an
explicit worktree and a string parameter named by `nativeCompletion`. The selected
source is checked before sending the prompt. The method waits for both the ordinary
ask result and matching native evidence; it returns the reply once. Use normal
finite feedback edges and turn/time budgets. Never wire a second continuation from
an inferred status change. Automated completion events stay suppressed as roots;
external human turns retain the normal trigger behaviour.

Subscription replacement/stopping rejects waits; unknown or lost operations are
observed, never automatically resent. Standalone `pudl run` does not support this
method. Update the offline authoring kit to obtain generated askNative types.


Retained readouts can also be reconciled after clean owner shutdown on application
28.21+: use `observe-retained-readout` with the exact recorded owner and operation id.
This executes only the captured adapter's observation method and never restarts the
graph. See [readout delivery checks](readouts.md#check-a-delivery-after-stop).

For current Linux/macOS crash recovery and limited host lifetimes, see [recovery](recovery.md).

The [flow-node guide](flow.md) explains the shared Transform, Format text,
Condition, Merge and Join templates and `examples/flow.json`. The kit and IDE use
the same source; copying a component never arms it.

## Copy a saved huddle

On application 28.26+, inspect the saved source first, then supply that digest:

```sh
pudl huddle duplicate 0123456789abcdef0123456789abcdef \
  --name 'Review copy' --profile work --project 0123456789 --worktree /srv/app \
  --request '{"expected_digest":"<digest from inspect>"}'
```

MCP `huddle_duplicate` takes `project_id`, `worktree`, `huddle_id`, `name` and
`expected_digest`. Both return the new stopped placement and document. They copy
the reviewed saved definition in the same worktree, with a fresh id; no runtime
or trigger starts. The full bounded source tree includes README, fixtures, unused
components and empty directories, with a limit of 128 files/256 entries, 256 KiB
per file and 4 MiB total. Links, non-regular files and invalid UTF-8 are rejected.

The manifest's top-level id/name change; other source and literal bindings remain
as written. Review account/session/worktree settings and supply fresh private
variable bindings or integration grants before activation. Unsaved drafts and
private execution state are never copied. On a stale digest, inspect and review
again. On a lost response, list saved huddles and open the already-created copy;
do not repeat the mutation automatically. Partial files remain discoverable after
publication or placement failures.

## Create from a starter

On application 28.27+, add `--request '{"template":"manual"}'` or
`--request '{"template":"review-loop"}'` to `pudl huddle create --name NAME
--project PROJECT_ID --worktree ABSOLUTE_WORKTREE`. MCP `huddle_create` accepts the
same optional `template` field. Omit it for the existing blank graph. All choices
create stopped placements with fresh ids; failed replies still require discovery
before another explicit creation.

The offline authoring kit includes `starters/manual/` and `starters/review-loop/`
with the same source, layout, README and input fixtures. If copying kit assets
manually, replace the all-zero manifest id with a newly generated directory id and
replace the review starter's explicit `/replace/with/registered/worktree` literal.
The host creation command supplies its selected canonical worktree automatically.
Review-loop intentionally omits both agent parameters: select two existing agents
in the node settings (or edit explicit session bindings), then validate. It uses
existing Prompt/Review scripts, five feedback rounds, ten turns and approval-only
Result output. There is no coordinator agent or automatic completion echo route.
