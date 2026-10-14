import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { interactiveResource } from '../interactive/control.js';

export async function prepareOpenCodeInteractive(context: LifecycleLaunchContext) {
  if (!(await lifecycleVersionAtLeast('opencode', ['--version'], [1, 18, 10])))
    throw new Error('OpenCode 1.18.10+ is required for interactive puddlang turns');
  return interactiveResource(context, context.account.config_dir, '\x1b');
}
