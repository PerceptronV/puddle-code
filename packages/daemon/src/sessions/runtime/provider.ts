import type { Account } from '@puddle/shared';
import type { AgentAdapter } from '../../agents/adapter.js';
import type { RuntimeLaunchGuard } from '../../runtime/lifecycle/launcher.js';
import { ApiError } from '../../http/errors.js';

/** Apply provider requirements to the exact release pinned by the ordinary launcher. */
export async function providerResumeGuard(
  adapter: AgentAdapter,
  account: Account,
  ref: string | undefined,
  before?: RuntimeLaunchGuard,
): Promise<RuntimeLaunchGuard | undefined> {
  const required = ref ? await adapter.resumeRuntimeProtocol?.(ref, account) : null;
  if (!required) return before;
  return (selected) => {
    before?.(selected);
    if (selected.protocol.major !== required.major || selected.protocol.minor < required.minor)
      throw ApiError.conflict(
        'runtime_provider_unsupported',
        'The selected runtime cannot safely attach this native session. Upgrade the runtime before resuming it.',
      );
  };
}
