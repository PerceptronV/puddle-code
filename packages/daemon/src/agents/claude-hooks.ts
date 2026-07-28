import { execPath } from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Hook-driven status signals for claude-code (SPEC §4/§5): the reliable
 * replacement for scraping the TUI with regexes. Claude Code fires documented
 * hook events at exactly the moments puddle's status machine cares about, so
 * we install a tiny helper into the account's config dir and register it for:
 *
 *   Stop                              → waiting_input (turn finished)
 *   Notification(permission_prompt)   → waiting_input (approval needed)
 *   Notification(idle_prompt)         → waiting_input (idle at the prompt)
 *   UserPromptSubmit                  → working       (a prompt went in)
 *   PreToolUse                        → working       (tool call — also the
 *                                       resume-after-approval moment, which
 *                                       fires no UserPromptSubmit)
 *
 * The helper POSTs `{nonce, state}` to the daemon's /agent-signal endpoint;
 * both values arrive via env vars the daemon injects into the agent PTY at
 * spawn (hook processes inherit the agent's environment). Outside puddle the
 * vars are absent and the helper exits silently, so the hooks are inert for
 * a `claude` run by hand against the same config dir. Hooks in the config
 * dir's settings.json apply to every session using that CLAUDE_CONFIG_DIR
 * (verified against Claude Code 2.1.219, like the event timing above).
 */
const HELPER_FILE = 'puddle-signal.mjs';

const HELPER_SOURCE = `// puddle status signal (managed by puddled — safe to delete, reinstalled at boot)
const state = process.argv[2];
const url = process.env.PUDDLE_AGENT_SIGNAL_URL;
const nonce = process.env.PUDDLE_AGENT_SIGNAL_NONCE;
// Drain stdin so the parent never blocks writing the hook payload.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
if (!url || !nonce || (state !== 'working' && state !== 'waiting_input')) process.exit(0);
try {
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, state }),
    signal: AbortSignal.timeout(1500),
  });
} catch {
  // The daemon being unreachable must never disturb the agent.
}
process.exit(0);
`;

/** Hook registrations, one per (event, matcher) — see the module doc. */
const HOOK_EVENTS: Array<{ event: string; matcher?: string; state: 'working' | 'waiting_input' }> =
  [
    { event: 'Stop', state: 'waiting_input' },
    { event: 'Notification', matcher: 'permission_prompt', state: 'waiting_input' },
    { event: 'Notification', matcher: 'idle_prompt', state: 'waiting_input' },
    { event: 'UserPromptSubmit', state: 'working' },
    { event: 'PreToolUse', state: 'working' },
  ];

interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

/**
 * Installs the signal helper and registers the hook entries in the config
 * dir's settings.json. Idempotent, and additive to the user's own hooks: only
 * groups whose commands reference our helper are replaced; everything else in
 * the file (including foreign hooks on the same events) is preserved.
 */
export function installStatusHooks(configDir: string): void {
  const helperPath = join(configDir, HELPER_FILE);
  writeFileSync(helperPath, HELPER_SOURCE, { mode: 0o700 });

  const settingsFile = join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    } catch {
      // A corrupt settings file is replaced by one carrying only our hooks.
    }
  }
  const hooks =
    settings['hooks'] && typeof settings['hooks'] === 'object'
      ? (settings['hooks'] as Record<string, unknown>)
      : {};

  // The daemon's pinned node runs claude on this same host, so its path is
  // valid for the hook subprocess too (mirrors claude-statusline.ts).
  const command = (state: string) =>
    `${JSON.stringify(execPath)} ${JSON.stringify(helperPath)} ${state}`;

  // Collate our groups per event FIRST — an event can carry several matchers
  // (Notification), and filtering per entry would strip the sibling just added.
  const byEvent = new Map<string, HookGroup[]>();
  for (const { event, matcher, state } of HOOK_EVENTS) {
    const ours: HookGroup = {
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: 'command', command: command(state) }],
    };
    byEvent.set(event, [...(byEvent.get(event) ?? []), ours]);
  }
  for (const [event, oursList] of byEvent) {
    const groups: HookGroup[] = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    const foreign = groups.filter(
      (g) => !(g?.hooks ?? []).some((h) => h?.command?.includes(HELPER_FILE)),
    );
    hooks[event] = [...foreign, ...oursList];
  }

  settings['hooks'] = hooks;
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
