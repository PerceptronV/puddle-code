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
Standalone JSON Schema/type bundles, component fixtures, graph diff and
activation/lifecycle CLI/MCP operations remain pending. The originally proposed
directory-only validation command is superseded by the explicit scope above.
