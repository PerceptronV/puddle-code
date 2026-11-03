import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

export const CLAUDE_STATUSLINE_SOURCE = `import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const out = process.env.PUDDLE_AGENT_HELPER_DIR && process.env.CLAUDE_CONFIG_DIR
  ? join(process.env.CLAUDE_CONFIG_DIR, '${STATUS_FILE}')
  : fileURLToPath(new URL('./${STATUS_FILE}', import.meta.url));
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let line = '';
  try {
    const j = JSON.parse(raw);
    const ctx = j.context_window?.used_percentage ?? null;
    const snapshot = {
      captured_at: new Date().toISOString(),
      context_used_percentage: typeof ctx === 'number' ? ctx : null,
      total_cost_usd: j.cost?.total_cost_usd ?? null,
      model: j.model?.display_name ?? null,
    };
    writeFileSync(out, JSON.stringify(snapshot));
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
  if (!existsSync(file)) return null;
  try {
    const snap = JSON.parse(readFileSync(file, 'utf8')) as ClaudeLiveUsage;
    return typeof snap.captured_at === 'string' ? snap : null;
  } catch {
    return null;
  }
}
