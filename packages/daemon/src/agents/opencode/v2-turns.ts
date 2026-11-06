/** OpenCode 2.2.5 durable inbox/step events, separate from TUI selection. */
export const OPENCODE_V2_TURNS_SOURCE = `import { createHash, randomUUID } from 'node:crypto';
export function createTurns(context, current, signal) {
  let turn = null;
  const reset = () => { turn = null; };
  const valid = (value) => turn === value && current(value.ref);
  const fail = async (value, error) => {
    if (!valid(value)) return;
    turn = null;
    await signal({ event: 'turn_failed', agent_session_ref: value.ref, turn_id: value.id,
      error: error.slice(0, 4096) }, value.ref);
  };
  const receive = async (event) => {
    const data = event.data;
    const ref = data?.sessionID;
    if (!current(ref)) return;
    if (event.type === 'session.inbox.enqueued' && data.item?.type === 'user') {
      const rawPrompt = data.item.payload?.text;
      if (typeof rawPrompt !== 'string' || Buffer.byteLength(rawPrompt) > 1024 * 1024) return;
      // The native composer appends a separator after bracketed paste. Preserve
      // the prompt itself, normalising only whitespace after our terminal marker.
      const marker = /\\[puddle-turn:([0-9a-f-]{36})\\]\\s*$/.exec(rawPrompt);
      const prompt = marker ? rawPrompt.trimEnd() : rawPrompt;
      if (turn?.message === data.inboxID) return;
      const previous = turn;
      const value = { ref, message: data.inboxID, delivered: false, assistant: null,
        id: marker?.[1] || randomUUID() };
      turn = value;
      if (previous) await signal({ event: 'turn_failed', agent_session_ref: ref,
        turn_id: previous.id, error: 'Another native prompt replaced this turn' }, ref);
      if (!valid(value)) return;
      await signal({ event: 'turn_start', agent_session_ref: ref, turn_id: value.id,
        prompt_hash: createHash('sha256').update(prompt).digest('hex') }, ref);
      return;
    }
    const value = turn;
    if (!value || value.ref !== ref) return;
    if (event.type === 'session.inbox.cancelled' && data.inboxID === value.message)
      return fail(value, 'Native prompt cancelled');
    if (event.type === 'session.inbox.delivered' && data.inboxID === value.message) {
      value.delivered = true;
      return;
    }
    // A queued prompt cannot be completed by the preceding execution's events.
    if (!value.delivered) return;
    if (event.type === 'session.step.started') value.assistant = data.assistantMessageID;
    if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted')
      return fail(value, event.type.endsWith('interrupted') ? 'Native turn interrupted' : 'Native turn failed');
    if (event.type !== 'session.execution.succeeded' || value.finishing) return;
    value.finishing = true;
    try {
      if (!value.assistant) throw new Error('OpenCode completed without an observed assistant step');
      const message = await context.client.session.message.get(
        { sessionID: ref, messageID: value.assistant }, { signal: AbortSignal.timeout(5000) });
      if (!valid(value)) return;
      if (message.id !== value.assistant || message.type !== 'assistant' ||
          message.finish !== 'stop' || !message.time?.completed)
        throw new Error('OpenCode did not retain a final assistant reply');
      const reply = message.content.filter((part) => part.type === 'text').map((part) => part.text || '').join('');
      if (Buffer.byteLength(reply) > 256 * 1024) throw new Error('Agent reply exceeds 256 KiB');
      if (!valid(value)) return;
      turn = null;
      await signal({ event: 'turn_complete', agent_session_ref: ref, turn_id: value.id, reply }, ref);
    } catch (error) { await fail(value, String(error)); }
  };
  return { reset, receive };
}
`;
