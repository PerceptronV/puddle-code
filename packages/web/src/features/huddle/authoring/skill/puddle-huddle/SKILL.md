---
name: puddle-huddle
description: Create or edit Puddle huddle graphs and their local puddlang components in the explicitly selected project worktree.
---

# Author a Puddle huddle

The invocation supplies the profile, project, worktree, huddle id, directory and
user's task. Work on that huddle's ordinary source files. An authoring session is
an ordinary coding agent, separate from agents the graph manages. These
instructions are supplied in the initial prompt; they do not imply that a skill
has been installed in the account's home directory.

## Source and contracts

When available, `pudl huddle authoring` lists bundled schemas, wrapper types,
editable templates and fake fixtures; `pudl huddle authoring README.md` explains
them, and an exact listed path reads one asset as JSON `{path, content, ...}`.
This command is local and takes no host/profile/worktree flags. MCP exposes the
same kit as `huddle_authoring` with optional `path`. Assets identify the bundled
client protocol, not target-host support. Read relevant templates before adapting
them; validate the resulting saved graph on the selected host. Kit reads neither
write files nor execute the examples.

- Each worktree contains independent `.puddle/huddle/<32-lowercase-hex-id>/`
  directories. Keep the directory id and `huddle.json` id equal. Names may change;
  do not rename the directory or alter other huddles to perform an ordinary edit.
- `huddle.json` is a format-1 graph. Nodes have stable ids and either
  `source: {kind: "builtin", component: "puddle.trigger.manual", version: 1}`
  or `source: {kind: "local", manifest: "nodes/example/node.json"}`.
  Edges use `{id, from: {node, port}, to: {node, port}}`.
- `layout.json` is optional format-1 presentation data with
  `nodes: {"node-id": {x: 0, y: 0}}`. Preserve unrelated positions and appearance.
- Local components declare `format: 1`, a namespaced `id`, positive `version`,
  `category` (`trigger`, `script`, or `readout`), `title`, `inputs`, `outputs`,
  `parameters`, `capabilities`, and an `entry` relative to the component manifest.
  List imported local helpers in `dependencies`. Source capture is bounded and
  rejects symlink/path escapes; do not rely on arbitrary installed packages.
- Ports and parameters each have a `schema`. The supported JSON Schema subset
  includes type, enum, properties, required, additionalProperties, items and
  numeric/string/array bounds; unsupported keywords fail validation. Parameter
  `editor` values such as `prompt`, `worktree`, `session`, `account`, `agent`,
  `project`, `number`, `boolean` and `json` select inspector controls.
- Node parameter bindings use `{kind: "literal", value: ...}` or
  `{kind: "variable", name: "declaredVariable"}`. Inspect the existing graph's
  bindings and component contracts before changing them. File, Git and session
  capabilities require an explicit `worktree` parameter with editor `worktree`,
  bound to a literal registered worktree or a declared variable. Never substitute
  the process cwd for that binding. Accounts and sessions remain profile scoped.

For a script component, the entry exports a HuddleNode declaration:

```ts
import { HuddleNode } from 'puddlang/huddle';

export default HuddleNode({
  contract: './node.json',
  async run({ inputs, parameters, bindings, puddlang, signal, emit }) {
    // Return values for declared completion outputs. Await emit for event ports.
    return { completed: inputs.value };
  },
});
```

The matching component needs input `value` and output `completed` (each can use
`{schema: {}}`). Inputs/settings are immutable; observe cancellation. Use the
scoped `puddlang` bridge for managed agent operations. Do not invent runtime ids
or dispatch duplicate asks to recover an uncertain response.

## Data flow

The kit includes editable Transform, Format text, Condition, Merge and Join
components, also offered in Add node on application 28.25. Start with
`examples/flow.json` for a complete branching/fan-out graph. Transform's initial
script returns its input; edit source and contracts together. Format text uses
`{{input}}` / `{{input.field}}`. Condition compares a field path with a JSON value
and emits exactly one of `matched`/`unmatched`; missing fields fail. Merge uses
`any` activation and forwards each arrival independently. Join uses `all` and
requires the same execution and activation, so wire shared fan-out branches.
Never join unrelated triggers or mutually exclusive condition outputs; use Merge
for alternatives. Existing bounded feedback edges handle cycles separately.

## Agent flow and feedback

Use editable templates from **Add node** when available: Prompt/Review agent
(application 28.3), Spawn agent (28.8), and Prompt/Review spawned agent (28.9).
Inspect their published contracts and scripts rather than guessing provider APIs.
Authoring can use ordinary accounts without scripted-turn support; agents invoked
by graph nodes still require that support and a capable pinned runtime.

Two agents may talk to each other. Feedback must be an explicit bounded edge,
with a condition and finite round limit; removing feedback edges must leave an
acyclic graph. Keep execution agent, turn, duration and resource limits finite.
Never build an unbounded automatic reply loop or silently increase budgets.
Prompt templates substitute `{{input}}` and own-property `{{input.field}}` values.

On 28.9, required inputs with `scope: "execution"` retain a single value for the
same execution/revision; they need all-input activation plus an ordinary required
input. Wire Spawn's agent handle into the retained `agent` input of a spawned-agent
template, and replies into its ordinary input. Feedback must not target retained
inputs. This permits reuse across rounds without spawning another agent each time.

Custom triggers use HuddleTrigger with an explicit resume policy, durable cursors
and acknowledged event admission. Custom readouts use HuddleReadout with declared
idempotency, reconciliation and cancellation support. Treat unknown delivery as
unknown, not success or permission to repeat a side effect. Consult available
trigger/readout templates or supplied wrapper types for the exact adapter methods;
do not implement external integrations from guessed signatures. Keep credentials
out of graph source and prompts. On application 28.23 with integrationSecrets:1,
use string parameters with editor secret and no default. Store only logical
references in settings; adapters use context.secrets?.PARAMETER_NAME. The operator
configures exact profile/project/huddle/canonical-worktree grants in private
huddle-integrations.json under Puddle home. Never request credential values in the
agent prompt or write them into project files. Start/Apply checks availability;
workers recheck at startup. Keep secrets out of outputs, receipts and cursors too.
Secret-worker diagnostics are redacted; Interrupt/Resume or Stop/Start refreshes
running workers after host-side rotation.

## Save, inspect, activate

Saving files, successful static validation and completion of this authoring turn
do not activate a graph. Keep the existing runtime on its captured revision.
Do not Start, Apply, Run or arm external triggers unless the user separately
requested execution. Opening or importing a module to validate it executes trusted
code: prefer data-only contract/graph inspection. If the installed `pudl --help`
advertises huddle source tools, use:

```text
pudl huddle list --profile PROFILE --project PROJECT_ID --worktree ABSOLUTE_WORKTREE
pudl huddle inspect HUDDLE_ID --profile PROFILE --project PROJECT_ID --worktree ABSOLUTE_WORKTREE
pudl huddle validate HUDDLE_ID --profile PROFILE --project PROJECT_ID --worktree ABSOLUTE_WORKTREE
```

Substitute the exact invocation scope. Paths are on the selected host; use `--host`
only when invoking from a different machine over SSH. Validation returns JSON
`{valid, digest, diagnostics}` and exits 1 for error diagnostics. Unreadable or
invalid root manifests and authority failures are command errors. It does not
type-check or execute scripts, test integrations or prove live resource admission.
The equivalent MCP tools are `huddle_list`, `huddle_inspect`, `huddle_validate`
with `project_id`, `worktree` and (except list) `huddle_id`; use them only if exposed
on the current connection. Never claim a check ran when it did not. If these tools
are unavailable, the IDE's refreshed graph shows diagnostics. Review saved source
and its diff before explicit activation. External changes use normal editor
conflict handling; do not overwrite someone else's intervening edits.

If execution is explicitly requested and the installed tools support it, use
`pudl huddle open HUDDLE_ID --project PROJECT_ID --worktree ABSOLUTE_WORKTREE`
to obtain the placement's `session.id`; this is distinct from the directory id.
`create --name NAME` with the same scope creates a blank inactive graph/placement.
`runtime SESSION_ID` inspects its exact owner. Start/Apply/Run/Interrupt/Resume/Stop,
history and observe-readout take `SESSION_ID --request JSON`, using the existing
HTTP request body. Include the reviewed `expected_digest` and explicit `variables`
for Start/Apply, and the inspected `owner.target` verbatim for Apply and later
mutations. Run additionally requires `node`, a stable caller-chosen UUID `event_id`
and `data`. History takes `owner: {runtimeId, incarnation}`, `collection`, `after`
and the required parent for invocations/operations. MCP equivalents take
`{session_id, request}`. Never invent missing targets, silently fetch replacements,
or repeat a mutation after a lost reply; inspect runtime/history first. Start,
Apply and Resume can arm triggers immediately. Resume rearms the graph, not an
agent session or interrupted script. Tool availability does not grant execution
authority beyond the user's task.

On application 28.10+, `revision SESSION_ID --request JSON` reads retained active
source/bindings with `{target}`; `diff` additionally requires the saved
`expected_digest`. Add `entry: {kind: "file" | "component", path: "..."}` for one
file or resolved node contract. These reads never apply or execute. Use the exact
returned target/digest for an authorised Apply; stale review requires explicit
inspection again. Retained-only inspection works without project source while the
owner is connected. MCP equivalents are `huddle_revision|diff` with
`{session_id, request}`.

For requested placement management, `session SESSION_ID` reads archive status;
`archive SESSION_ID` stops the current owner and hides the placement, while
`unarchive SESSION_ID` leaves it stopped. These use the placement's declared scope
and take no request body or worktree override. MCP equivalents are
`huddle_session|archive|unarchive` with `{session_id}`. Archive targets the current
placement owner, unlike Stop's reviewed exact target. After a failed reply inspect
session/runtime; do not automatically repeat it. Neither action deletes source or
recreates a missing worktree.

Report the files changed, checks actually performed and any remaining diagnostics.
Keep authoring within the requested task. This invocation does not grant additional
accounts, cross-profile access, nested delegation or automatic execution authority.

On host 28.21+, `observe-retained-readout SESSION_ID --request JSON` checks an unknown
readout after confirmed clean owner shutdown. Supply `{owner, operation_id}` from
recorded history; the captured adapter must support observation. It does not restart
the graph or redeliver. Recover interrupted owners first. Request
`include_readout_observation: true` in retained history for eligible offers and
inspect retained outcomes after acceptance or lost replies, without automatic retry.
