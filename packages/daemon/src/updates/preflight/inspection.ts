import {
  hostUpdateOperationSchema,
  type HostUpdateOperation,
  type HostReleaseCapabilities,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { HostUpdateCompatibility, UpdateCompatibility } from './compatibility.js';
import type { HostUpdateCapacity, UpdateCapacity } from './capacity.js';
import type { HostUpdateImpact, UpdateImpact } from './impact.js';
import type { HostUpdateConnector, UpdateConnector } from './connector.js';
import type { HostUpdateSupervision, UpdateSupervision } from './supervision.js';

export interface UpdateInspection {
  compatibility: UpdateCompatibility;
  connector: UpdateConnector;
  capacity: UpdateCapacity;
  impact: UpdateImpact;
  supervision: UpdateSupervision;
  blockers: Array<
    | UpdateCompatibility['blockers'][number]
    | UpdateCapacity['blockers'][number]
    | UpdateSupervision['blockers'][number]
    | UpdateConnector['blockers'][number]
    | { code: 'connector_inventory_changed'; target: 'connector' }
    | { code: 'database_schema_changed'; target: 'daemon' }
    | { code: 'interruption_inventory_changed'; target: 'daemon' }
  >;
  fingerprint: string | null;
}

/** Observations for the coordinator; authority, worker isolation and quiescence are separate. */
export class HostUpdateInspection {
  constructor(
    private readonly deps: {
      compatibility: Pick<
        HostUpdateCompatibility,
        'inspect' | 'inventoryMatches' | 'databaseMatches'
      >;
      connector: Pick<HostUpdateConnector, 'inspect'>;
      capacity: Pick<HostUpdateCapacity, 'inspect'>;
      impact: Pick<HostUpdateImpact, 'inspect'>;
      supervision: Pick<HostUpdateSupervision, 'inspect'>;
    },
  ) {}

  async inspect(
    input: HostUpdateOperation,
    cockpit: HostReleaseCapabilities['application'],
    installedRuntime: HostReleaseCapabilities['runtime'] | null,
  ): Promise<UpdateInspection> {
    const operation = hostUpdateOperationSchema.parse(input);
    const before = this.deps.impact.inspect(operation);
    const connector = await this.deps.connector.inspect(operation);
    const supervision = await this.deps.supervision.inspect(operation);
    // Inspect owners after slow filesystem probes, then recheck their inventory
    // synchronously after the final connector probe. Dispatch also holds admissions.
    const capacity = await this.deps.capacity.inspect(operation);
    const compatibility = await this.deps.compatibility.inspect(
      operation,
      cockpit,
      installedRuntime,
      connector.identity?.remote ?? null,
    );
    const connectorAfter = await this.deps.connector.inspect(operation);
    const impact = this.deps.impact.inspect(operation);
    const blockers: UpdateInspection['blockers'] = [
      ...compatibility.blockers,
      ...capacity.blockers,
      ...supervision.blockers,
      ...connector.blockers,
    ];
    if (!this.deps.compatibility.inventoryMatches(compatibility))
      blockers.push({ code: 'runtime_inventory_unknown', target: 'inventory' });
    if (!this.deps.compatibility.databaseMatches(compatibility))
      blockers.push({ code: 'database_schema_changed', target: 'daemon' });
    if (JSON.stringify(connector) !== JSON.stringify(connectorAfter)) {
      blockers.push(...connectorAfter.blockers);
      blockers.push({ code: 'connector_inventory_changed', target: 'connector' });
    }
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
            protocols: { cockpit, installedRuntime },
            connector,
            candidates: compatibility.candidates,
            database_schema_version: compatibility.database_schema_version,
            owners: compatibility.owners,
            inventory: compatibility.inventory,
            impact: impact.fingerprint,
            supervision: { worker: supervision.worker, daemon: supervision.daemon },
          }),
        );
    return { compatibility, connector, capacity, impact, supervision, blockers, fingerprint };
  }
}
