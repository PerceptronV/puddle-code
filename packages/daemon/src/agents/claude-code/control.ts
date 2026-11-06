import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { interactiveResource } from '../interactive/control.js';
import { turnHookSource } from '../interactive/hook-source.js';
import {
  installHookDispatcher,
  managedHookCommand,
  writeManagedHelper,
} from '../managed-helpers.js';

/** Native UserPromptSubmit/Stop payloads, Claude Code 2.1.300 hook contract. */
export const CLAUDE_TURN_SOURCE = turnHookSource(`
  if (input.agent_id || process.env.CLAUDE_JOB_DIR) return null;
  const ref = input.session_id;
  if (mode === 'start') return { kind: 'start', ref, prompt: input.prompt };
  if (mode === 'failed') return { kind: 'end', ref, error: input.error_details || input.error || 'Claude turn failed' };
  return { kind: 'end', ref, reply: input.last_assistant_message };
`);

export function installClaudeTurnHooks(configDir: string): void {
  const file = join(configDir, 'puddle-turn.mjs');
  writeManagedHelper(file, CLAUDE_TURN_SOURCE);
  installHookDispatcher(configDir);
  const settingsFile = join(configDir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  };
  for (const [event, mode] of [
    ['UserPromptSubmit', 'start'],
    ['Stop', 'complete'],
    ['StopFailure', 'failed'],
  ]) {
    const groups = settings.hooks[event!] ?? [];
    settings.hooks[event!] = [
      ...groups.filter((g) => !g.hooks?.some((h) => h.command?.includes('puddle-turn.mjs'))),
      {
        hooks: [
          {
            type: 'command',
            command: managedHookCommand(configDir, 'puddle-turn.mjs', mode!),
          },
        ],
      },
    ];
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

export async function prepareClaudeInteractive(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('claude', ['--version'], [2, 1, 300], context.env))) {
    if (await lifecycleVersionAtLeast('claude', ['--version'], [2, 1, 238], context.env))
      return { args: context.args, dispose() {} };
    throw new Error('Claude Code lifecycle hooks are unavailable');
  }
  // StopFailure is version-gated; older normal TUIs keep their existing hooks.
  installClaudeTurnHooks(context.account.config_dir);
  return interactiveResource(context, context.account.config_dir, '\x1b');
}
