import type { LifecycleLaunchContext, LifecycleLaunchResource } from '../adapter.js';
import { lifecycleVersionAtLeast } from '../lifecycle-version.js';
import { prepareCodexLifecycle } from './lifecycle.js';

/** Keep even degraded interactive launches inside the runtime's process lifetime. */
export async function prepareCodexLaunch(
  context: LifecycleLaunchContext,
): Promise<LifecycleLaunchResource> {
  try {
    return await prepareCodexLifecycle(context);
  } catch (error) {
    // Verified on Codex 0.164.0. Its default TUI attaches to a shared daemon,
    // which keeps idle conversations loaded for 60 seconds after disconnect.
    // A restarted runtime can otherwise race that daemon's writer ownership.
    // Older CLIs retain their original fallback arguments.
    if (!(await lifecycleVersionAtLeast('codex', ['--version'], [0, 164, 0], context.env)))
      throw error;
    context.reportLifecycleUnavailable?.();
    console.warn(
      'Codex lifecycle bridge unavailable; using a foreground CLI without its shared daemon',
    );
    return {
      args: ['--no-daemon', ...context.args],
      dispose() {},
    };
  }
}
