import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { prepareHeadless } from '../headless/control.js';
import { record, schemaPrompt, type HeadlessDriver } from '../headless/codec.js';

/** Stream-json fields verified against @google/gemini-cli-core 0.53.1 output/types.d.ts. */
export function geminiDriver(context: LifecycleLaunchContext): HeadlessDriver {
  return {
    binary: 'gemini',
    env: { GEMINI_CLI_HOME: context.account.config_dir },
    command: (ref, prompt, schema) => ({
      args: [
        '--output-format',
        'stream-json',
        ...(ref ? ['--resume', ref] : ['--session-id', context.opts.sessionId]),
        ...(context.opts.skipPermissions ? ['--approval-mode', 'yolo'] : []),
        '--prompt',
        '',
      ],
      // 0.53.1 selects headless mode for --prompt even when empty and consumes
      // piped stdin. Keep bounded large prompts out of OS argv size limits.
      stdin: schemaPrompt(prompt, schema),
    }),
    decoder: () => {
      let reply = '';
      return (event) => {
        if (event['type'] === 'tool_use') {
          reply = '';
          return { reply, text: '\n' };
        }
        if (event['type'] === 'init' && typeof event['session_id'] === 'string')
          return { ref: event['session_id'] };
        if (
          event['type'] === 'message' &&
          event['role'] === 'assistant' &&
          typeof event['content'] === 'string'
        ) {
          reply = event['delta'] === true ? reply + event['content'] : event['content'];
          return { text: event['content'], reply };
        }
        if (event['type'] === 'result')
          return event['status'] === 'success'
            ? { complete: true, reply }
            : { error: String(record(event['error'])['message'] ?? 'Gemini turn failed') };
        return {};
      };
    },
  };
}

export async function prepareGeminiHeadless(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('gemini', ['--version'], [0, 53, 1])))
    throw new Error('Gemini CLI 0.53.1+ is required for headless mode');
  return prepareHeadless(context, geminiDriver(context));
}
