import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { prepareHeadless } from '../headless/control.js';
import { record, schemaPrompt, type HeadlessDriver } from '../headless/codec.js';

/** `exec`/`exec resume --json` flags checked against codex-cli 0.159.0. */
export function codexDriver(context: LifecycleLaunchContext): HeadlessDriver {
  return {
    binary: 'codex',
    env: { CODEX_HOME: context.account.config_dir },
    command: (ref, prompt, schema) => ({
      args: [
        'exec',
        ...(ref ? ['resume'] : []),
        '--json',
        ...(context.opts.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        ...(ref ? [ref] : []),
        '-',
      ],
      stdin: schemaPrompt(prompt, schema),
    }),
    decoder: () => {
      let reply = '';
      return (event) => {
        if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string')
          return { ref: event['thread_id'] };
        if (event['type'] === 'item.completed') {
          const item = record(event['item']);
          if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
            reply = item['text'];
            return { text: reply + '\n', reply };
          }
        }
        if (event['type'] === 'turn.failed')
          return { error: String(record(event['error'])['message'] ?? 'Codex turn failed') };
        if (event['type'] === 'turn.completed') return { complete: true, reply };
        return {};
      };
    },
  };
}

export async function prepareCodexHeadless(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('codex', ['--version'], [0, 159, 0])))
    throw new Error('Codex 0.159.0+ is required for headless mode');
  return prepareHeadless(context, codexDriver(context));
}
