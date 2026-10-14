import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { prepareScripted } from '../scripted/control.js';
import { record, schemaPrompt, type ScriptedDriver } from '../scripted/codec.js';

/** Flags checked with OpenCode 1.18.10 `run --help`; events use its JSON run protocol. */
export function openCodeDriver(context: LifecycleLaunchContext): ScriptedDriver {
  return {
    binary: 'opencode',
    env: Object.fromEntries(
      ['CONFIG', 'DATA', 'CACHE', 'STATE'].map((kind) => [
        `XDG_${kind}_HOME`,
        `${context.account.config_dir}/${kind.toLowerCase()}`,
      ]),
    ),
    command: (ref, prompt, schema) => ({
      args: [
        'run',
        '--format',
        'json',
        ...(ref ? ['--session', ref] : []),
        ...(context.opts.skipPermissions ? ['--auto'] : []),
      ],
      stdin: schemaPrompt(prompt, schema),
    }),
    decoder: () => {
      let reply = '';
      return (event) => {
        const ref = typeof event['sessionID'] === 'string' ? event['sessionID'] : undefined;
        const part = record(event['part']);
        if (event['type'] === 'error')
          return {
            error: String(
              record(record(event['error'])['data'])['message'] ?? 'OpenCode turn failed',
            ),
          };
        if (event['type'] === 'text' && typeof part['text'] === 'string') {
          reply += part['text'];
          return { ref, text: part['text'], reply };
        }
        if (event['type'] === 'step_finish') {
          if (part['reason'] === 'stop') return { ref, complete: true, reply };
          if (part['reason'] !== 'tool-calls')
            return { error: `OpenCode stopped with ${String(part['reason'])}` };
          // Intermediate assistant text is not the final reply after tool calls.
          reply = '';
        }
        return { ref };
      };
    },
  };
}

export async function prepareOpenCodeScripted(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('opencode', ['--version'], [1, 18, 10])))
    throw new Error('OpenCode 1.18.10+ is required for scripted mode');
  return prepareScripted(context, openCodeDriver(context));
}
