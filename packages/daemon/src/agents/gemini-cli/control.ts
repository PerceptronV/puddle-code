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

/** Documented BeforeAgent/AfterAgent payloads; 0.53.1 lifecycle baseline. */
export const GEMINI_TURN_SOURCE = turnHookSource(
  `
  const ref = input.session_id;
  if (mode === 'start') return { kind: 'start', ref, prompt: input.prompt };
  return { kind: 'end', ref, prompt: input.prompt, reply: input.prompt_response };
`,
  `process.stdout.write('{}\\n');`,
);

export function installGeminiTurnHooks(configDir: string): void {
  const dir = join(configDir, '.gemini');
  const file = join(dir, 'puddle-turn.mjs');
  writeManagedHelper(file, GEMINI_TURN_SOURCE);
  installHookDispatcher(dir);
  const settingsFile = join(dir, 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ name?: string; type: string; command: string }> }>
    >;
  };
  for (const [event, mode] of [
    ['BeforeAgent', 'start'],
    ['AfterAgent', 'complete'],
  ]) {
    const groups = settings.hooks[event!] ?? [];
    settings.hooks[event!] = [
      ...groups.filter((g) => !g.hooks?.some((h) => h.command?.includes('puddle-turn.mjs'))),
      {
        hooks: [
          {
            name: `puddle-turn-${mode}`,
            type: 'command',
            command: managedHookCommand(dir, 'puddle-turn.mjs', mode!),
          },
        ],
      },
    ];
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

export async function prepareGeminiInteractive(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('gemini', ['--version'], [0, 53, 1])))
    throw new Error('Gemini CLI 0.53.1+ is required for interactive puddlang turns');
  return interactiveResource(context, join(context.account.config_dir, '.gemini'), '\x03');
}
