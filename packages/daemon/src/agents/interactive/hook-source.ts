/** Shared hook-process plumbing; provider modules supply only their native field mapping. */
export function turnHookSource(normalise: string, output = ''): string {
  return `// Puddle turn observation (managed by puddled).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 1024 * 1024) process.exit(0);
}
try {
  const input = JSON.parse(raw || '{}');
  const mode = process.argv[2];
  const event = (() => { ${normalise} })();
  if (url && nonce && event && typeof event.ref === 'string') {
    const path = join(dirname(fileURLToPath(import.meta.url)), '.puddle-turn-' + createHash('sha256').update(nonce).digest('hex') + '.json');
    let turn;
    if (event.kind === 'start' && typeof event.prompt === 'string') {
      turn = {
        ref: event.ref,
        id: /\\[puddle-turn:([0-9a-f-]{36})\\]$/.exec(event.prompt)?.[1] || randomUUID(),
        hash: createHash('sha256').update(event.prompt).digest('hex'),
      };
      writeFileSync(path, JSON.stringify(turn), { mode: 0o600 });
    } else {
      try { turn = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    }
    if (turn?.ref === event.ref && (event.kind === 'start' || typeof event.prompt !== 'string' ||
        createHash('sha256').update(event.prompt).digest('hex') === turn.hash)) {
      const tooLarge = typeof event.reply === 'string' && Buffer.byteLength(event.reply) > 256 * 1024;
      await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, agent_session_ref: event.ref, turn_id: turn.id,
          event: event.kind === 'start' ? 'turn_start' : event.error || tooLarge ? 'turn_failed' : 'turn_complete',
          ...(event.kind === 'start' ? { prompt_hash: turn.hash } : {}),
          ...(event.error || tooLarge ? { error: String(event.error || 'Agent reply exceeds 256 KiB').slice(0, 4096) }
            : typeof event.reply === 'string' ? { reply: event.reply } : {}),
        }), signal: AbortSignal.timeout(1500),
      });
    }
  }
} catch { /* Observability must never disturb an interactive agent. */ }
${output}
`;
}
