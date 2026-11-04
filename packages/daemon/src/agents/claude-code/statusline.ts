import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  installHookDispatcher,
  legacyHelperCommand,
  managedHookCommand,
  writeManagedHelper,
} from '../managed-helpers.js';

/**
 * Live per-session usage capture for claude-code, via the documented
 * statusLine mechanism (SPEC §5). Claude Code invokes a status-line command
 * on every session update, passing a JSON payload on stdin. We point that at
 * a tiny helper (run by its owner's pinned Node) which records the
 * fields we surface — context-window fill and cost — into a puddle-owned file
 * in the managed account, and prints a compact line for the terminal.
 *
 * This is credential-free and documented: it reads no tokens, only the usage
 * numbers Claude Code already computes. The subscription rate-limit view
 * (`/usage`) is NOT in this payload (verified against 2.1.209) and lives
 * behind the separate opt-in path.
 *
 * Payload fields consumed (verified against Claude Code 2.1.209):
 *   context_window.used_percentage  — 0..100 or null before the first turn
 *   cost.total_cost_usd             — ~0 for subscription accounts (unmetered)
 *   model.display_name
 */
const STATUS_FILE = 'puddle-status.json';
const HELPER_FILE = 'puddle-statusline.mjs';
const INPUT_BYTES = 64 * 1024;
const STATUS_BYTES = 4096;
const MODEL_CHARACTERS = 256;

export const CLAUDE_STATUSLINE_SOURCE = `import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const out = process.env.PUDDLE_AGENT_HELPER_DIR && process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, '${STATUS_FILE}')
  : fileURLToPath(new URL('./${STATUS_FILE}', import.meta.url));
let raw = '';
let bytes = 0;
let refused = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (refused) return;
  bytes += Buffer.byteLength(d);
  if (bytes > ${INPUT_BYTES}) { refused = true; raw = ''; return; }
  raw += d;
});
process.stdin.on('error', () => { refused = true; raw = ''; });
process.stdin.on('end', () => {
  if (refused) return;
  let line = '';
  try {
    const j = JSON.parse(raw);
    const ctx = j.context_window?.used_percentage ?? null;
    const cost = j.cost?.total_cost_usd;
    const model = j.model?.display_name;
    const snapshot = {
      captured_at: new Date().toISOString(),
      context_used_percentage: typeof ctx === 'number' && Number.isFinite(ctx) && ctx >= 0 && ctx <= 100 ? ctx : null,
      total_cost_usd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
      model: typeof model === 'string' && model.length <= ${MODEL_CHARACTERS} ? model.replace(/[\\x00-\\x1f\\x7f]/g, '') : null,
    };
    writeFileSync(out, JSON.stringify(snapshot), { mode: 0o600 });
    line =
      (snapshot.model ?? '') +
      (snapshot.context_used_percentage != null
        ? \`  ctx \${Math.round(snapshot.context_used_percentage)}%\`
        : '');
  } catch {
    line = '';
  }
  process.stdout.write(line);
});
`;

export interface ClaudeLiveUsage {
  captured_at: string;
  context_used_percentage: number | null;
  total_cost_usd: number | null;
  model: string | null;
}

/**
 * Installs the helper and points settings.json at it — but never clobbers a
 * status line the user (or an imported account) already configured.
 */
export function installStatusLine(configDir: string): void {
  writeManagedHelper(join(configDir, HELPER_FILE), CLAUDE_STATUSLINE_SOURCE);
  installHookDispatcher(configDir);
  const settingsFile = join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    } catch {
      // A corrupt settings file is replaced by one carrying only our line.
    }
  }
  const command = managedHookCommand(configDir, HELPER_FILE);
  const previous = settings['statusLine'];
  if (previous !== undefined) {
    if (
      !previous ||
      typeof previous !== 'object' ||
      !('type' in previous) ||
      previous.type !== 'command' ||
      !('command' in previous) ||
      (previous.command !== command &&
        !legacyHelperCommand(previous.command, join(configDir, HELPER_FILE)))
    )
      return;
  }
  settings['statusLine'] = {
    ...(previous && typeof previous === 'object' ? previous : {}),
    type: 'command',
    command,
  };
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

/** The most recent captured live-usage snapshot, or null if none yet. */
export function readLiveUsage(configDir: string): ClaudeLiveUsage | null {
  const file = join(configDir, STATUS_FILE);
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > STATUS_BYTES) return null;
      // One bounded buffer also catches a file that grows after inspection.
      const buffer = Buffer.alloc(STATUS_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, size);
        if (!count) break;
        size += count;
      }
      if (size > STATUS_BYTES) return null;
      value = JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
    } finally {
      closeSync(fd);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snap = value as Record<string, unknown>;
    const finite = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (
      typeof snap.captured_at !== 'string' ||
      snap.captured_at.length > 64 ||
      !Number.isFinite(Date.parse(snap.captured_at)) ||
      !(
        snap.context_used_percentage === null ||
        (finite(snap.context_used_percentage) && snap.context_used_percentage <= 100)
      ) ||
      !(snap.total_cost_usd === null || finite(snap.total_cost_usd)) ||
      !(
        snap.model === null ||
        (typeof snap.model === 'string' && snap.model.length <= MODEL_CHARACTERS)
      )
    )
      return null;
    return {
      captured_at: snap.captured_at,
      context_used_percentage: snap.context_used_percentage,
      total_cost_usd: snap.total_cost_usd,
      model: snap.model,
    };
  } catch {
    return null;
  }
}
