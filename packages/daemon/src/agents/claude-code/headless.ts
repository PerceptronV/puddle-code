import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { prepareHeadless } from '../headless/control.js';
import { record, type HeadlessDriver } from '../headless/codec.js';

/** Flags checked against Claude Code 2.1.300; result events follow its print protocol. */
export function claudeDriver(context: LifecycleLaunchContext): HeadlessDriver {
  return {
    binary: 'claude',
    env: { CLAUDE_CONFIG_DIR: context.account.config_dir },
    command: (ref, prompt, schema) => ({
      args: [
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        ...(ref ? ['--resume', ref] : ['--session-id', context.opts.sessionId]),
        ...(context.opts.skipPermissions ? ['--dangerously-skip-permissions'] : []),
        ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
      ],
      stdin: prompt,
    }),
    decoder: () => (event) => {
      // Subagent messages must never bind or complete the parent ask.
      if (event['parent_tool_use_id']) return {};
      const ref = typeof event['session_id'] === 'string' ? event['session_id'] : undefined;
      if (event['type'] === 'system' && event['subtype'] === 'init') return { ref };
      if (event['type'] === 'assistant') {
        const content = record(event['message'])['content'];
        return {
          text: Array.isArray(content)
            ? content
                .map(record)
                .filter((p) => p['type'] === 'text')
                .map((p) => String(p['text'] ?? ''))
                .join('') + '\n'
            : undefined,
        };
      }
      if (event['type'] !== 'result') return {};
      if (event['is_error'] || event['subtype'] !== 'success')
        return {
          error: String(event['result'] ?? JSON.stringify(event['errors'] ?? 'Claude turn failed')),
        };
      // A denied tool is not silently reported as successful autonomous work.
      if (Array.isArray(event['permission_denials']) && event['permission_denials'].length)
        return {
          error:
            'Claude requires tool permission; use interactive mode or configure the account permissions',
        };
      return {
        ref,
        complete: true,
        reply:
          event['structured_output'] !== undefined
            ? JSON.stringify(event['structured_output'])
            : String(event['result'] ?? ''),
      };
    },
  };
}

export async function prepareClaudeHeadless(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('claude', ['--version'], [2, 1, 300])))
    throw new Error('Claude Code 2.1.300+ is required for headless mode');
  return prepareHeadless(context, claudeDriver(context));
}
