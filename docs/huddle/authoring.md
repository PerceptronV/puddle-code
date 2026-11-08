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

For custom extensions, see [triggers](triggers.md) and [readouts](readouts.md).
Standalone JSON Schema/type bundles and huddle CLI/MCP commands are still pending.
In particular, `pudl huddle validate` is proposed syntax, not a current command.
