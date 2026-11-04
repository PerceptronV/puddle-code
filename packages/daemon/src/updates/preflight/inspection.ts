import {
  hostUpdateOperationSchema,
  type HostUpdateOperation,
  type HostReleaseCapabilities,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { HostUpdateCompatibility, UpdateCompatibility } from './compatibility.js';
import type { HostUpdateCapacity, UpdateCapacity } from './capacity.js';
import type { HostUpdateImpact, UpdateImpact } from './impact.js';
import type { HostUpdateSupervision, UpdateSupervision } from './supervision.js';

export interface UpdateInspection {
  compatibility: UpdateCompatibility;
  capacity: UpdateCapacity;
  impact: UpdateImpact;
  supervision: UpdateSupervision;
  blockers: Array<
    | UpdateCompatibility['blockers'][number]
    | UpdateCapacity['blockers'][number]
    | UpdateSupervision['blockers'][number]
    | { code: 'interruption_inventory_changed'; target: 'daemon' }
  >;
  fingerprint: string | null;
}

/** Observations for the coordinator; authority, worker isolation and quiescence are separate. */
export class HostUpdateInspection {
  constructor(
    private readonly deps: {
      compatibility: Pick<HostUpdateCompatibility, 'inspect'>;
      capacity: Pick<HostUpdateCapacity, 'inspect'>;
      impact: Pick<HostUpdateImpact, 'inspect'>;
      supervision: Pick<HostUpdateSupervision, 'inspect'>;
    },
  ) {}

  async inspect(
    input: HostUpdateOperation,
    cockpit: HostReleaseCapabilities['application'],
    installedRuntime: HostReleaseCapabilities['runtime'] | null,
    connectorRemote: number | null,
  ): Promise<UpdateInspection> {
    const operation = hostUpdateOperationSchema.parse(input);
    const before = this.deps.impact.inspect(operation);
    const supervision = await this.deps.supervision.inspect(operation);
    // Inspect owners last so a slow filesystem probe cannot outlive the owner
    // inventory comparison. The final coordinator still rechecks under its barrier.
    const capacity = await this.deps.capacity.inspect(operation);
    const compatibility = await this.deps.compatibility.inspect(
      operation,
      cockpit,
      installedRuntime,
      connectorRemote,
    );
    const impact = this.deps.impact.inspect(operation);
    const blockers: UpdateInspection['blockers'] = [
      ...compatibility.blockers,
      ...capacity.blockers,
      ...supervision.blockers,
    ];
    if (before.fingerprint !== impact.fingerprint)
      blockers.push({ code: 'interruption_inventory_changed', target: 'daemon' });
    // Free bytes vary continuously: admission is rechecked, not approved as an
    // exact byte count. Bind approval to release/owner/impact identities instead.
    const fingerprint = blockers.length
      ? null
      : digest(
          JSON.stringify({
            operation: operation.id,
            targets: operation.targets,
            stages: operation.stages.map((stage) => stage.digest),
            protocols: { cockpit, installedRuntime, connectorRemote },
            candidates: compatibility.candidates,
            owners: compatibility.owners,
            inventory: compatibility.inventory,
            impact: impact.fingerprint,
            supervision: { worker: supervision.worker, daemon: supervision.daemon },
          }),
        );
    return { compatibility, capacity, impact, supervision, blockers, fingerprint };
  }
}
