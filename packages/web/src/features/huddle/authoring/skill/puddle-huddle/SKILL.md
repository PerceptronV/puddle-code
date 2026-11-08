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
out of graph source and prompts.

## Save, inspect, activate

Saving files, successful static validation and completion of this authoring turn
do not activate a graph. Keep the existing runtime on its captured revision.
Do not Start, Apply, Run or arm external triggers unless the user separately
requested execution. Opening or importing a module to validate it executes trusted
code: prefer data-only contract/graph inspection. `pudl huddle validate` is not
implemented; do not report that command as available or claim a check ran when it
did not. The IDE's refreshed graph shows diagnostics; review saved source and its
diff before explicit activation. External changes use normal editor conflict
handling; do not overwrite someone else's intervening edits.

Report the files changed, checks actually performed and any remaining diagnostics.
Keep authoring within the requested task. This invocation does not grant additional
accounts, cross-profile access, nested delegation or automatic execution authority.
