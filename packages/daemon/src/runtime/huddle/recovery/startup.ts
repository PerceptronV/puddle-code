import { readHostBootIdentity } from '@puddle/shared/node/host-control';
import type { RuntimeStore } from '../../../db/stores/runtimes.js';
import type { SessionStore } from '../../../db/stores/sessions.js';
import type { ProjectStore } from '../../../db/stores/projects.js';
import type { StorageMonitor } from '../../../storage/monitor.js';
import { huddleRecoveryPlacementAvailable } from './placement.js';
import type { RuntimeLauncher } from '../../lifecycle/launcher.js';
import { huddleBindingLaunch } from '../ownership/binding.js';
import { readRecordedHuddleControl } from '../state/readers/activation.js';

/** One bounded pass at daemon startup. Recovery's existing launch intent owns any accepted attempt. */
export async function recoverHuddlesAtStartup(deps: {
  home: string;
  runtimes: Pick<RuntimeStore, 'huddleStartupCandidates' | 'stopRequested'>;
  sessions: Pick<SessionStore, 'get'>;
  projects: Pick<ProjectStore, 'get'>;
  launcher: Pick<RuntimeLauncher, 'recoverHuddle'>;
  storage?: Pick<StorageMonitor, 'assertAdmission'>;
  failed(id: string, error: unknown): void;
}) {
  const boot = await readHostBootIdentity();
  if (!boot) return;
  let after = '';
  for (;;) {
    const candidates = deps.runtimes.huddleStartupCandidates(after);
    if (!candidates.length) return;
    for (const binding of candidates) {
      after = binding.runtime_id;
      try {
        const source = huddleBindingLaunch(deps.home, binding);
        if (source.capabilities.autoStart !== 1 || !source.boot_id || source.boot_id === boot)
          continue;
        const valid = () => huddleRecoveryPlacementAvailable(deps, binding);
        if (!valid()) continue;
        const control = readRecordedHuddleControl(deps.home, source.scope);
        if (control.state !== 'armed' || !control.autoStart) continue;
        await deps.storage?.assertAdmission([deps.home, binding.canonical_worktree_path]);
        if (!valid()) continue;
        // The launcher checks the opt-in again under source retirement/state claims.
        // Same-boot replacements (including lost replies) are excluded on subsequent boots of puddled.
        await deps.launcher.recoverHuddle(
          binding.active_session_id,
          { runtimeId: binding.runtime_id, incarnation: binding.incarnation },
          valid,
          { autoStartOnly: true },
        );
      } catch (error) {
        deps.failed(binding.active_session_id, error);
      }
    }
  }
}
