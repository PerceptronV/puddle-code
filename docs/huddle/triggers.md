# Custom huddle triggers

Application 28.7 and a runtime advertising `customTriggers: 1` can run project-local
trigger adapters. They use the same captured manifest/settings editor as script
and readout nodes. Add a local contract path with **Add node**, connect its output,
save, and choose **Start** or **Apply saved**. Reading source or editing settings
never opens a subscription.

A live huddle owns up to eight custom subscriptions in independent workers.
Closing the frontend or disconnecting the daemon leaves those workers running.
**Custom triggers** below the execution tray shows each source's ready, degraded,
gap or closed state. A failed adapter stops its source; healthy sources continue.
Inspect a gap, then Interrupt/Resume to reopen subscriptions. This does not retry
failed graph scripts or uncertain deliveries.

## Contract and lifecycle

Put a component under `.puddle/huddle/<huddle_id>/nodes/<name>/`:

```json
{
  "format": 1,
  "id": "project.trigger.feed",
  "version": 1,
  "category": "trigger",
  "title": "Feed",
  "entry": "./trigger.ts",
  "trigger": { "resume": "continue" },
  "capabilities": ["network"],
  "parameters": {
    "url": { "schema": { "type": "string" }, "editor": "text" },
    "intervalMs": {
      "schema": { "type": "integer", "minimum": 15000 },
      "editor": "number",
      "default": 60000
    }
  },
  "outputs": { "event": { "schema": {}, "emission": "event" } }
}
```

The wrapper exports `HuddleTrigger({ contract, async open(context, cursor) })`.
`open` must return an object with `async close()` within ten seconds, after
establishing its subscription. Opening is not permission to leave unowned watchers
or timers behind. Close every watcher/socket/timer, settle pending callbacks, and
pass `context.signal` to cancellable I/O. Interrupt, Stop and Apply fence old
callbacks immediately, then wait for positive worker exit before replacing them.
Cooperative cleanup has a short grace period before forced termination.

Context includes frozen `parameters` and resolved `bindings`, an abort `signal`,
bounded `log(message)`, and three acknowledged operations:

- `await emit({ id, port, data, nextCursor, occurredAt? })`: validate the named output
  and durably admit its root event and cursor together. The receipt contains an inbox
  `sequence` and `duplicate` flag. Stable ids must retain the same payload and cursor.
- `await checkpoint(cursor)`: retain a baseline or explicitly empty-page progress
  without creating a graph execution. Never use it to skip an event whose emission
  has not been acknowledged.
- `await health({ state: 'ready' | 'degraded' | 'gap' | 'closed', ... })`: persist
  health. Degraded needs `message`; gap needs `message` and `after` cursor. Gap and
  closed end this subscription. Opening reports ready automatically only when the
  adapter has not already reported health.

Cursor values are bounded JSON, at most 64 KiB. `continue` resumes the retained
cursor after Interrupt/Resume, including source events that occurred while paused
when the source can still supply them. `fresh` passes null after Resume. A new Apply
activation always starts with null and a fresh event-identity namespace. Reopening
the same generation preserves progress. The adapter defines what a null cursor
means: establish a current baseline or deliberately consume retained source history.
It must report expired/missing history as a gap, not silently claim catch-up.

The owner derives scope, revision, execution id and applicable worktree identity
from the admitted activation. Stable external ids are hashed with the retained
subscription identity for durable deduplication. Repeated emissions do not rewind
the current cursor. Admission/storage failure acknowledges nothing and leaves both
cursor and execution budgets unchanged.

## Example: a bounded pull feed

This example assumes an endpoint returning a bounded event page with a cursor on
each event, a page cursor, and an explicit `gap` flag. Adapt that source contract to
the service you use. No inbound webhook server or package installation is needed.

```ts
import { HuddleTrigger } from 'puddlang/huddle';
import { z } from 'zod';

const pageSchema = z.object({
  gap: z.boolean(),
  cursor: z.string().max(4096),
  events: z.array(z.object({
    id: z.string().min(1).max(256),
    cursor: z.string().max(4096),
    data: z.json(),
  })).max(16),
});

async function readPage(response: Response) {
  if (!response.body) throw new Error('Feed response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new Error('Feed page exceeds 256 KiB');
      text += decoder.decode(value, { stream: true });
    }
    return pageSchema.parse(JSON.parse(text + decoder.decode()));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export default HuddleTrigger({
  contract: './node.json',
  async open(context, initialCursor) {
    let cursor = initialCursor;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();

    async function poll() {
      try {
        const url = new URL(String(context.parameters.url));
        if (cursor !== null) url.searchParams.set('after', String(cursor));
        const response = await fetch(url, {
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error(`Feed returned ${response.status}`);
        const page = await readPage(response);
        if (page.gap) {
          closed = true;
          await context.health({ state: 'gap', message: 'Feed cursor expired', after: cursor });
          return;
        }
        for (const event of page.events) {
          await context.emit({
            id: event.id, port: 'event', data: event.data,
            nextCursor: event.cursor,
          });
          cursor = event.cursor;
        }
        await context.checkpoint(page.cursor);
        cursor = page.cursor;
        await context.health({ state: 'ready' });
      } catch (error) {
        if (!closed && !context.signal.aborted)
          await context.health({ state: 'degraded', message: String(error).slice(0, 4096) });
      }
    }
    function schedule() {
      if (closed || context.signal.aborted) return;
      timer = setTimeout(() => {
        pending = poll().finally(schedule);
      }, Number(context.parameters.intervalMs));
    }
    await poll();
    schedule();
    return {
      async close() {
        closed = true;
        clearTimeout(timer);
        await pending;
      },
    };
  },
});
```

The example bounds response bytes, page size and request time. Adapt those limits
to the service and retain them in production adapters. Put credentials outside
graph/source files. The [authoring kit](authoring.md#packaged-authoring-kit) ships an
editable version with fake fixtures and generated wrapper types. Authentication
can use [private integration references](integrations.md) on supporting runtimes.

## Resource and compatibility limits

Each subscription uses a managed 160 MiB child allowance and a 128 MiB JavaScript
heap limit, separately from graph-node concurrency. The shared host memory gate may
refuse a source; its gap is visible. Worker transport and pending requests remain
bounded. The SDK permits 64 calls per second and at most 64 pending calls; the owner
allows two sender bursts per second to accommodate window boundaries. Logging is
limited to 1 MiB per minute. Idle subscriptions have no lifetime deadline or growing
request-id history. Blocked startup, runaway requests/logging and unexpected exit
end the source. Unknown process termination blocks owner cleanup until resolved.

File, Git and session capabilities require an explicit registered worktree parameter
and resolved binding. Session selectors are observations, not permission to prompt
an agent; trigger workers cannot call puddlang agent operations or emit script-node
outputs. Use graph script nodes for actions. Custom code still runs with the host
user's OS authority; declarations and captured imports are not a security sandbox.

Existing agent/terminal owners and huddle runtimes without custom-trigger support
remain usable. Unsupported runtimes cannot launch or Apply custom-trigger graphs.
Automatic owner-crash replacement is supported on verified Linux cgroup-v2 scopes;
other same-boot platform recovery and integration-specific acceptance remain open.

For authenticated services, use [private integration-secret references](integrations.md).
