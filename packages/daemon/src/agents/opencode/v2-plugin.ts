/** The selected TUI route is authority; server-wide reads/activity never select a chat. */
export const OPENCODE_V2_PLUGIN_SOURCE = `import { createTurns } from './puddle-sync-v2-turns.mjs';
export function PuddleSyncV2(context, { createRoot, createEffect }) {
  const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
  const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
  const version = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:$|[-+])/.exec(context.app?.version || '');
  if (!version || Number(version[1]) !== 2 || Number(version[2]) < 2 ||
      (Number(version[2]) === 2 && Number(version[3]) < 5)) return;
  if (!url || !nonce || !context.ui?.router || !context.client?.session ||
      typeof context.data?.listen !== 'function') return;
  let closed = false, active = null, epoch = 0, selected = null, lastMetadata = null;
  let pendingHome = false;
  const created = new Set();
  let sending = Promise.resolve(), queued = 0;
  const current = (ref) => !closed && typeof ref === 'string' && ref === active && ref === selected;
  const signal = (body, ref) => {
    if (closed || queued >= 32) return Promise.resolve();
    queued++;
    const send = sending.then(async () => {
      if (closed || (ref && !current(ref))) return;
      try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, ...body }), signal: AbortSignal.timeout(1500) }); }
      catch { /* A lost observation must never interrupt the native TUI. */ }
    }).finally(() => { queued--; });
    sending = send.catch(() => {});
    return send;
  };
  const turns = createTurns(context, current, signal);
  const select = async (ref, generation, info) => {
    try {
      info ??= await context.client.session.get({ sessionID: ref }, { signal: AbortSignal.timeout(1500) });
      if (closed || generation !== epoch || selected !== ref || !info || info.parentID) return;
      // Activity timestamps change on every execution event. Catalogue watches
      // already maintain them; only identity/title changes need a TUI signal.
      const metadata = JSON.stringify([ref, info.title]);
      if (metadata === lastMetadata) return;
      const previous = active;
      if (previous !== ref) turns.reset();
      active = ref;
      lastMetadata = metadata;
      const source = previous === ref ? 'resume' : previous === null ? 'startup' : info.fork?.sessionID === previous ? 'fork'
        : created.has(ref) ? 'clear' : 'resume';
      created.delete(ref);
      await signal({ event: 'session_start', agent_session_ref: ref,
        cwd: info.location?.directory || context.location?.directory || process.cwd(), source,
        ...(info.fork?.sessionID ? { parent_agent_session_ref: info.fork.sessionID } : {}),
        ...(typeof info.title === 'string' ? { native_title: info.title } : {}),
        ...(info.time?.created ? { native_created_at: new Date(info.time.created).toISOString() } : {}),
        ...(info.time?.updated ? { native_updated_at: new Date(info.time.updated).toISOString() } : {}) }, ref);
    } catch { /* Keep the previous binding until selection can be inspected exactly. */ }
  };
  const stop = context.data.listen(({ details: event }) => {
    if (closed) return;
    const data = event.data;
    if (event.type === 'session.created' && !data.parentID && data.sessionID !== active) {
      created.add(data.sessionID);
      if (created.size > 128) created.delete(created.values().next().value);
    }
    // Ignore read watermarks and activity from other root sessions/subagents.
    if (event.type === 'session.deleted' && current(data.sessionID)) {
      const ref = active;
      epoch++;
      turns.reset();
      void signal({ event: 'session_end', agent_session_ref: ref,
        cwd: event.location?.directory || context.location?.directory || process.cwd(), source: 'exit' });
      active = null; selected = null; lastMetadata = null;
    }
    if (event.type.startsWith('session.inbox.') || event.type.startsWith('session.step.') ||
        event.type.startsWith('session.execution.')) void turns.receive(event);
  });
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      const route = context.ui.router.current();
      if (route.type === 'session') {
        pendingHome = false;
        const info = context.data.session.get(route.sessionID);
        if (selected !== route.sessionID) { turns.reset(); selected = route.sessionID; epoch++; }
        void select(route.sessionID, epoch, info);
      } else if (route.type === 'home') {
        // A managed blank terminal needs a native identity before the first prompt.
        // Native /new returns home; create through its API, then select only if
        // the user has not navigated elsewhere while that request was in flight.
        if (pendingHome) return;
        pendingHome = true;
        const generation = ++epoch;
        selected = null;
        turns.reset();
        void context.client.session.create({ location: context.location ?? context.data.location.default() },
          { signal: AbortSignal.timeout(5000) }).then((info) => {
          if (closed || generation !== epoch || context.ui.router.current().type !== 'home') return;
          created.add(info.id);
          context.ui.router.navigate({ type: 'session', sessionID: info.id });
        }).catch(() => {});
      } else { pendingHome = false; selected = null; epoch++; turns.reset(); }
    });
    return dispose;
  });
  return () => { closed = true; epoch++; turns.reset(); stop(); dispose(); };
}
`;
