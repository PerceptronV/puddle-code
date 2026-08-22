import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_FILE = 'puddle-sync.js';

const PLUGIN_SOURCE = `// Puddle native lifecycle bridge (managed by puddled).
export const PuddleSync = async ({ directory }) => {
  const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
  const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
  let active = null;
  const sessions = new Map();
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
    event: async ({ event }) => {
      const properties = event?.properties || {};
      const info = properties.info;
      if (info && !info.parentID) sessions.set(info.id, info);
      if (event?.type === 'session.created') await post(info, 'clear');
      if (event?.type === 'session.updated') await post(info, 'resume');
      if (event?.type === 'session.status') {
        await post(sessions.get(properties.sessionID), 'resume');
      }
      if (event?.type === 'session.deleted' && properties.info?.id === active) {
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
