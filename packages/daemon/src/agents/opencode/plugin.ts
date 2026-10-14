import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_FILE = 'puddle-sync.js';

// chat.message and session.message shapes checked against the published
// @opencode-ai/plugin and @opencode-ai/sdk 1.18.10 declarations.
const PLUGIN_SOURCE = `// Puddle native lifecycle bridge (managed by puddled).
import { createHash, randomUUID } from 'node:crypto';
export const PuddleSync = async ({ directory, client }) => {
  const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
  const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
  let active = null;
  const sessions = new Map();
  const turns = new Map();
  const signal = async (body) => {
    if (!url || !nonce) return;
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, ...body }), signal: AbortSignal.timeout(1500) });
    } catch { /* Never interrupt the native agent for observability. */ }
  };
  const finish = async (ref, error) => {
    const turn = turns.get(ref);
    if (!turn || ref !== active || turn.finishing) return;
    turn.finishing = true;
    try {
      if (error) throw new Error(error);
      if (!turn.assistant) throw new Error('OpenCode completed without a final assistant message');
      const result = await client.session.message({ path: { id: ref, messageID: turn.assistant }, signal: AbortSignal.timeout(5000) });
      if (turns.get(ref) !== turn) return;
      const message = result.data;
      if (message?.info?.parentID !== turn.message || message.info.finish !== 'stop')
        throw new Error('OpenCode reply does not match the submitted message');
      const reply = (message.parts || []).filter((p) => p.type === 'text' && !p.ignored).map((p) => p.text || '').join('');
      if (Buffer.byteLength(reply) > 256 * 1024) throw new Error('Agent reply exceeds 256 KiB');
      await signal({ event: 'turn_complete', agent_session_ref: ref, turn_id: turn.id, reply });
    } catch (error) {
      await signal({ event: 'turn_failed', agent_session_ref: ref, turn_id: turn.id, error: String(error).slice(0, 4096) });
    } finally { if (turns.get(ref) === turn) turns.delete(ref); }
  };
  const post = async (info, source) => {
    if (!url || !nonce || !info || info.parentID) return;
    const ref = info.id || info.sessionID;
    if (typeof ref !== 'string' || ref.length === 0) return;
    const changed = active !== null && active !== ref;
    active = ref;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nonce,
          event: 'session_start',
          agent_session_ref: ref,
          cwd: info.directory || directory,
          source: changed ? source : 'startup',
          ...(typeof info.title === 'string' ? { native_title: info.title } : {}),
          ...(info.time?.created ? { native_created_at: new Date(info.time.created).toISOString() } : {}),
          ...(info.time?.updated ? { native_updated_at: new Date(info.time.updated).toISOString() } : {}),
        }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      // The daemon being unreachable must never disturb OpenCode.
    }
  };
  return {
    'chat.message': async (input, output) => {
      const ref = input.sessionID;
      const info = sessions.get(ref);
      if (!info || info.parentID) return;
      await post(info, 'resume');
      const prompt = output.parts.filter((p) => p.type === 'text' && !p.synthetic).map((p) => p.text || '').join('');
      const id = /\\[puddle-turn:([0-9a-f-]{36})\\]$/.exec(prompt)?.[1] || randomUUID();
      turns.set(ref, { id, message: output.message.id });
      await signal({ event: 'turn_start', agent_session_ref: ref, turn_id: id,
        prompt_hash: createHash('sha256').update(prompt).digest('hex') });
    },
    event: async ({ event }) => {
      const properties = event?.properties || {};
      const info = properties.info;
      if (event?.type?.startsWith('session.') && info && !info.parentID) sessions.set(info.id, info);
      if (event?.type === 'session.created') await post(info, 'clear');
      if (event?.type === 'session.updated') await post(info, 'resume');
      if (event?.type === 'session.status') {
        await post(sessions.get(properties.sessionID), 'resume');
        if (properties.status?.type === 'idle') await finish(properties.sessionID);
      }
      if (event?.type === 'message.updated' && info?.role === 'assistant') {
        const turn = turns.get(info.sessionID);
        if (turn?.message === info.parentID && info.finish === 'stop' && info.time?.completed)
          turn.assistant = info.id;
      }
      if (event?.type === 'session.error') await finish(properties.sessionID, 'OpenCode turn failed');
      if (event?.type === 'session.deleted' && properties.info?.id === active) {
        await finish(active, 'Native conversation deleted');
        sessions.delete(active);
        active = null;
      }
    },
  };
};
`;

/** Install the managed top-level session plugin under OpenCode's XDG config. */
export function installOpenCodePlugin(configDir: string): void {
  const dir = join(configDir, 'config', 'opencode', 'plugins');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLUGIN_FILE), PLUGIN_SOURCE, { mode: 0o600 });
}
