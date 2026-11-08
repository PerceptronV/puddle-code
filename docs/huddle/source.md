# Captured source and guarded saves

On daemon application 28.11+, local/SSH clients can read a huddle's captured
source and publish one manifest/layout edit against that capture's digest. This
works without a running huddle or an installed supporting runtime. Saving never
activates code or starts an agent.

Run `pudl huddle source HUDDLE_ID --project PROJECT_ID --worktree /absolute/host/worktree`
to get `{document, files}`. `document.digest` covers the exact captured files and
resolved component contracts. `files` maps relative names to source text; it
includes referenced scripts and dependencies without executing them. Diagnostics
describe invalid/missing components: a capture is not proof that the graph can run.
Unreferenced files, credentials and private runtime state are not included.

Retain that capture while preparing an edit. Build a JSON request with:

```json
{
  "expected_digest": "THE_REVIEWED_CAPTURE_DIGEST",
  "edit": {
    "file": "layout.json",
    "content": "{\"format\":1,\"nodes\":{}}\n"
  }
}
```

This example clears stored node positions; supply your intended complete file
content instead. `file` must be `huddle.json` or `layout.json`. Pass the request
as `--request JSON` to `pudl huddle save-source HUDDLE_ID --project PROJECT_ID
--worktree /absolute/host/worktree`. Request JSON cannot override the command's
project, worktree or huddle id. Add the usual `--host`/`--profile` connection options
when needed. MCP equivalents are `huddle_source` and `huddle_save_source`; their
arguments include `project_id`, absolute `worktree` and `huddle_id`, plus
`expected_digest` and `edit` for a save.

The submitted text must parse as a supported, strict document with the same
huddle id. Unknown/future fields are rejected rather than discarded. Saves retain
whitespace, key order, CRLF, Unicode, omitted defaults and final-newline choice.
JSON documents must have no byte-order mark; script byte-order marks are retained
in captures. Source limits are 256 KiB per file, 128 files and 4 MiB per capture.
Graph diagnostics can remain in a saved draft; execution admission is separate.

A competing graph/layout, contract or captured script edit makes the old digest
stale. Read and reconcile the changes explicitly before another save. Never
refresh a digest and retry the old edit automatically. Each request publishes one
file; saving two files is not an atomic transaction.

The returned capture is an observation after publication. If the reply is lost,
or its file text differs from what you submitted, retain your draft and read
source to establish what is now on disk. The client verifies response identity,
metadata and digest, and makes no automatic retry. A failure is not evidence that
nothing was written. Repository exclusion coordinates Puddle writers; editors
outside Puddle do not participate in that lock. Detected changes fail the final
source comparison, but this is not a filesystem-wide lock on external processes.

The IDE still uses its ordinary per-file save/conflict lifecycle. Wiring these
captured baselines into shared drafts, reconciliation and window recovery is
remaining work; this interface does not yet change the IDE's Save button.
