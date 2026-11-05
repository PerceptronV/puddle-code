import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { prepareHeadless } from '../headless/control.js';
import { record, schemaPrompt, type HeadlessDriver } from '../headless/codec.js';

/** Flags checked with OpenCode 1.18.10 `run --help`; events use its JSON run protocol. */
export function openCodeDriver(
  context: LifecycleLaunchContext,
  standalone = false,
): HeadlessDriver {
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
        ...(standalone ? ['--standalone'] : []),
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

export async function prepareOpenCodeHeadless(context: LifecycleLaunchContext) {
  const standalone = await lifecycleVersionAtLeast(
    'opencode',
    ['--version'],
    [2, 0, 0],
    context.env,
    true,
  );
  if (
    !standalone &&
    !(await lifecycleVersionAtLeast('opencode', ['--version'], [1, 18, 10], context.env))
  )
    throw new Error('OpenCode 1.18.10+ is required for headless mode');
  return prepareHeadless(context, openCodeDriver(context, standalone));
}
