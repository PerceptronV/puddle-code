import type { ServiceTarget } from '../../host/supervision/target.js';
import {
  readSupervisorMarker,
  SupervisorMarkerPermissionsError,
} from '../../host/supervision/marker.js';
import {
  hostUpdateOperationSchema,
  type HostUpdateOperation,
  type HostServiceReplacement,
} from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  inspectRunningService,
  inspectHostServiceManager,
} from '../../host/supervision/inspection.js';
import { prepareServiceReplacement } from '../../host/supervision/replacement.js';
import { repairSupervisorMarker } from '../../host/supervision/repair-marker.js';

export interface UpdateSupervision {
  worker: Pick<ServiceTarget, 'kind' | 'domain'> | null;
  daemon: HostServiceReplacement | null;
  blockers: Array<{
    code:
      | 'supervisor_unavailable'
      | 'daemon_supervision_unknown'
      | 'daemon_supervisor_marker_permissions';
    target: string;
  }>;
}

export class HostUpdateSupervision {
  constructor(
    private readonly deps: {
      home: string;
      pid: number;
      platform?: NodeJS.Platform;
      uid?: number;
      run?: CompilationCommandRunner;
      definitionPath?: string;
    },
  ) {}

  async prepare(input: HostUpdateOperation, requireAuthority: () => void): Promise<void> {
    const operation = hostUpdateOperationSchema.parse(input);
    if (!operation.targets.some((target) => target.component === 'daemon')) return;
    requireAuthority();
    try {
      await repairSupervisorMarker(
        this.deps.home,
        this.deps.uid ?? process.getuid!(),
        async (kind) => {
          const manager = await inspectHostServiceManager(this.deps.home, this.deps);
          if (manager.kind !== kind) throw new Error('Unknown daemon supervision');
          const observed = await inspectRunningService(
            this.deps.home,
            { ...manager, name: kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled' },
            this.deps.pid,
            this.deps.run,
          );
          await prepareServiceReplacement(this.deps.home, observed, this.deps);
        },
        requireAuthority,
      );
    } catch {
      // Repair is best effort. Normal read-only preflight retains the blocker.
    }
    requireAuthority();
  }

  async inspect(input: HostUpdateOperation): Promise<UpdateSupervision> {
    const operation = hostUpdateOperationSchema.parse(input);
    const result: UpdateSupervision = { worker: null, daemon: null, blockers: [] };
    const uid = this.deps.uid ?? process.getuid?.();
    try {
      result.worker = await inspectHostServiceManager(this.deps.home, this.deps);
    } catch {
      result.blockers.push({ code: 'supervisor_unavailable', target: 'updater' });
      return result;
    }
    // A default-runtime update replaces no daemon; a manually started daemon need
    // not masquerade as a supervised one to select future runtime software.
    if (!operation.targets.some((target) => target.component === 'daemon')) return result;
    const kind = result.worker.kind;
    try {
      if ((await readSupervisorMarker(this.deps.home, uid!)) !== kind)
        throw new Error('Unknown daemon supervision');
      const observed = await inspectRunningService(
        this.deps.home,
        {
          ...result.worker,
          name: kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled',
        },
        this.deps.pid,
        this.deps.run,
      );
      result.daemon = await prepareServiceReplacement(this.deps.home, observed, this.deps);
    } catch (error) {
      result.blockers.push({
        code:
          error instanceof SupervisorMarkerPermissionsError
            ? 'daemon_supervisor_marker_permissions'
            : 'daemon_supervision_unknown',
        target: 'daemon',
      });
    }
    return result;
  }
}
