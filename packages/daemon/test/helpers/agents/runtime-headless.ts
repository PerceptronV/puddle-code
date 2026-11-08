import { join } from 'node:path';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
import { codexDriver } from '../../../src/agents/codex/headless.js';
import { prepareHeadless } from '../../../src/agents/headless/control.js';

/** Real headless control/terminal transport, with a fixture executable instead of an installed CLI. */
export function prepareRuntimeHeadless(context: LifecycleLaunchContext) {
  return prepareHeadless(context, {
    ...codexDriver(context),
    binary: process.execPath,
    command: (_ref, prompt) => ({
      args: [join(context.account.config_dir, 'headless-native.cjs')],
      stdin: prompt,
    }),
  });
}
