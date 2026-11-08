import type { HostUpdateDaemonHandoff } from '@puddle/shared';
import type { HostAdmission } from '../../host/lifecycle/admission.js';
import type { RuntimeConnections } from '../../runtime/transport/connections.js';
import { HostUpdatePause } from './pause.js';

type Participant = Pick<HostAdmission, 'pause'>;

/** Application writers drain while their downstream launch/observation services stay live. */
export function daemonUpdatePause(deps: {
  clients: Participant;
  upkeep: Participant;
  retention: Participant;
  programmes: Participant;
  huddles?: Participant;
  huddleSessions?: Participant;
  compilation: Participant;
  catalogue: Participant;
  markers: Participant;
  launcher?: Participant;
  sessions: Participant;
  controls: Participant;
  notebooks: Participant;
  notifications: Participant;
  cleanup: Participant;
  connections: Participant & Pick<RuntimeConnections, 'controllerIdentity'>;
  reconciler: Participant;
  refreshAccounts(): void;
}) {
  const pause = new HostUpdatePause([
    [deps.clients, deps.upkeep, deps.retention],
    [
      deps.programmes,
      ...(deps.huddles ? [deps.huddles] : []),
      ...(deps.huddleSessions ? [deps.huddleSessions] : []),
      deps.compilation,
      deps.catalogue,
      deps.markers,
    ],
    deps.launcher ? [deps.launcher] : [],
    [deps.sessions, deps.controls, deps.notebooks],
    [deps.notifications, deps.cleanup],
    [deps.connections],
    [deps.reconciler],
  ]);
  return async (
    timeoutMs?: number,
  ): Promise<{ release(): void; outgoing: HostUpdateDaemonHandoff['outgoing'] }> => {
    let held: Awaited<ReturnType<HostUpdatePause['acquire']>>;
    try {
      held = await pause.acquire(timeoutMs);
    } catch (error) {
      // acquire() already unwound any partial pause before rejecting.
      deps.refreshAccounts();
      throw error;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.release();
      // Login exits during maintenance may have missed their best-effort check.
      deps.refreshAccounts();
    };
    const controller = deps.connections.controllerIdentity();
    if (!controller) {
      release();
      throw new Error('Daemon controller ended during update inspection');
    }
    return { release, outgoing: { pid: process.pid, controller } };
  };
}
