import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hostUpdateOperationSchema,
  runtimeIdentitySchema,
  type HostReleaseCapabilities,
  type HostUpdateOperation,
} from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { RuntimeStore, RuntimeBinding } from '../../db/stores/runtimes.js';
import type { RuntimeConnections } from '../../runtime/transport/connections.js';
import { runtimeBindingIdentity } from '../../runtime/transport/connections.js';
import { acquireHostClaim, HostClaimBusy } from '../../security/claims.js';
import { readStageCapabilities } from './candidate.js';

type Protocol = HostReleaseCapabilities['application'];
type Blocker = {
  code:
    | 'candidate_unavailable'
    | 'cockpit_incompatible'
    | 'connector_incompatible'
    | 'runtime_default_incompatible'
    | 'runtime_incompatible'
    | 'runtime_unavailable'
    | 'runtime_identity_changed'
    | 'runtime_inventory_unknown';
  target: string;
};
export interface UpdateCompatibility {
  blockers: Blocker[];
  candidates: Array<{ digest: string; capabilities: HostReleaseCapabilities }>;
  owners: Array<{ id: string; session: string; build: string; protocol: Protocol }>;
  inventory: string | null;
}

const inventory = (rows: RuntimeBinding[]) =>
  JSON.stringify(
    [...rows]
      .sort((a, b) => a.runtime_id.localeCompare(b.runtime_id))
      .map((binding) => [
        runtimeBindingIdentity(binding),
        binding.active_session_id,
        binding.active_segment_id,
        binding.conversation_id,
        binding.account_id,
        binding.agent_type,
        binding.build,
        binding.protocol_major,
        binding.protocol_minor,
        binding.launch_fingerprint,
        binding.release_path,
        binding.state,
      ]),
  );

/** Compatibility inspection only; authority, impact, capacity and quiescence remain separate checks. */
export class HostUpdateCompatibility {
  constructor(
    private readonly deps: {
      home: string;
      current: HostReleaseCapabilities;
      runtimes: Pick<RuntimeStore, 'live' | 'get'>;
      connections: Pick<RuntimeConnections, 'get'>;
    },
  ) {}

  async inspect(
    input: HostUpdateOperation,
    cockpit: Protocol,
    installedRuntime: Protocol | null,
    connectorRemote: number | null,
  ): Promise<UpdateCompatibility> {
    const operation = hostUpdateOperationSchema.parse(input);
    if (operation.stages.length !== operation.targets.length)
      throw new Error('Host update is not completely staged');
    const result: UpdateCompatibility = {
      blockers: [],
      candidates: [],
      owners: [],
      inventory: null,
    };
    let daemon = this.deps.current;
    let runtime = installedRuntime;
    const replacesDaemon = operation.targets.some((target) => target.component === 'daemon');
    for (const stage of operation.stages) {
      try {
        const capabilities = await readStageCapabilities(this.deps.home, stage);
        result.candidates.push({ digest: stage.digest, capabilities });
        if (stage.record.component === 'daemon') daemon = capabilities;
        else runtime = capabilities.runtime;
      } catch {
        result.blockers.push({ code: 'candidate_unavailable', target: stage.record.component });
      }
    }
    if (daemon.application.major !== cockpit.major)
      result.blockers.push({ code: 'cockpit_incompatible', target: 'cockpit' });
    // A daemon activation also selects its bundled connector. Existing remote peers
    // cannot be assumed ready for a different remote protocol.
    if (replacesDaemon && connectorRemote !== null && daemon.remote !== connectorRemote)
      result.blockers.push({ code: 'connector_incompatible', target: 'connector' });
    if (!runtime || !daemon.supported_runtime_majors.includes(runtime.major))
      result.blockers.push({ code: 'runtime_default_incompatible', target: 'runtime' });
    // Changing the default runtime does not adopt or interrupt existing owners.
    if (!replacesDaemon) return result;
    const bindings = this.deps.runtimes.live(4097);
    if (bindings.length > 4096) {
      result.blockers.push({ code: 'runtime_inventory_unknown', target: 'inventory' });
      return result;
    }
    const before = inventory(bindings);
    result.inventory = digest(before);
    const known = new Set(bindings.map((binding) => binding.runtime_id));
    await this.inspectInventory(known, result.blockers);
    let index = 0;
    const deadline = performance.now() + 30_000;
    const inspect = async () => {
      while (index < bindings.length) {
        const binding = bindings[index++]!;
        result.owners.push({
          id: binding.runtime_id,
          session: binding.active_session_id,
          build: binding.build,
          protocol: { major: binding.protocol_major, minor: binding.protocol_minor },
        });
        if (!daemon.supported_runtime_majors.includes(binding.protocol_major)) {
          result.blockers.push({ code: 'runtime_incompatible', target: binding.runtime_id });
          continue;
        }
        const client = this.deps.connections.get(binding.runtime_id);
        try {
          if (performance.now() >= deadline) throw new Error('Owner inspection deadline reached');
          if (!client) throw new Error('Owner unavailable');
          const response = await client.request({ t: 'inspect' });
          if (response.t !== 'state') throw new Error('Owner did not report state');
          const expected = runtimeBindingIdentity(binding);
          if (
            Object.entries(expected).some(
              ([key, value]) => response.state.identity[key as keyof typeof expected] !== value,
            ) ||
            response.state.build !== binding.build ||
            response.state.protocol.major !== binding.protocol_major ||
            response.state.protocol.minor !== binding.protocol_minor ||
            this.deps.runtimes.get(binding.runtime_id)?.active_session_id !==
              binding.active_session_id
          )
            result.blockers.push({ code: 'runtime_identity_changed', target: binding.runtime_id });
          if (this.deps.connections.get(binding.runtime_id) !== client)
            throw new Error('Owner disconnected');
        } catch {
          result.blockers.push({ code: 'runtime_unavailable', target: binding.runtime_id });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, bindings.length) }, inspect));
    const after = this.deps.runtimes.live(4097);
    if (after.length > 4096 || inventory(after) !== before)
      result.blockers.push({ code: 'runtime_inventory_unknown', target: 'inventory' });
    result.owners.sort((a, b) => a.id.localeCompare(b.id));
    result.blockers.sort((a, b) => `${a.code}:${a.target}`.localeCompare(`${b.code}:${b.target}`));
    return result;
  }

  /** Recheck without yielding after other asynchronous preflight probes have finished. */
  inventoryMatches(observed: UpdateCompatibility): boolean {
    if (observed.inventory === null) return true; // Runtime-default changes inspect no owners.
    const current = this.deps.runtimes.live(4097);
    return current.length <= 4096 && digest(inventory(current)) === observed.inventory;
  }

  private async inspectInventory(known: Set<string>, blockers: Blocker[]): Promise<void> {
    try {
      const directory = await opendir(join(this.deps.home, 'runtimes'));
      let count = 0;
      for await (const entry of directory) {
        if (++count > 4096) throw new Error('Runtime inventory exceeds inspection limit');
        if (
          !entry.isDirectory() ||
          !runtimeIdentitySchema.shape.runtime_id.safeParse(entry.name).success
        ) {
          blockers.push({ code: 'runtime_inventory_unknown', target: 'inventory' });
          continue;
        }
        if (known.has(entry.name)) continue;
        const binding = this.deps.runtimes.get(entry.name);
        // Unknown records never become proof of absence. A supposedly ended binding
        // with a live owner/launcher is also unresolved; never retire anything here.
        if (!binding) {
          blockers.push({ code: 'runtime_inventory_unknown', target: entry.name });
          continue;
        }
        for (const scope of ['runtime', 'runtime-launch', 'runtime-dispatch']) {
          try {
            acquireHostClaim(this.deps.home, `${scope}:${entry.name}`).release();
          } catch (error) {
            if (!(error instanceof HostClaimBusy)) throw error;
            blockers.push({ code: 'runtime_inventory_unknown', target: entry.name });
            break;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        blockers.push({ code: 'runtime_inventory_unknown', target: 'inventory' });
    }
  }
}
