import type { LifecycleLaunchContext } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { interactiveResource } from '../interactive/control.js';

export async function prepareOpenCodeInteractive(context: LifecycleLaunchContext) {
  // OpenCode 2 clients otherwise discover/start an account-wide background
  // server. A private server must end with this runtime, including fallback.
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
    throw new Error('OpenCode 1.18.10+ is required for interactive puddlang turns');
  const args = standalone ? ['--standalone', ...context.args] : context.args;
  if (
    standalone &&
    (!(await lifecycleVersionAtLeast('opencode', ['--version'], [2, 2, 5], context.env)) ||
      (await lifecycleVersionAtLeast('opencode', ['--version'], [3, 0, 0], context.env)))
  ) {
    // OpenCode 2 rejects V1 plugin hooks. Keep its terminal private, but do not
    // advertise exact identity/turn control without a verified V2 TUI bridge.
    context.reportLifecycleUnavailable?.();
    return { args, dispose() {} };
  }
  return interactiveResource({ ...context, args }, context.account.config_dir, '\x1b');
}
