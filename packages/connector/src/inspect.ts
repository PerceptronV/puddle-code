import { profileDirectory } from './profile-state.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectorConfigSchema,
  remoteIdentitySchema,
  type CockpitRemoteStatus,
} from '@puddle/shared';
import { identityPeer } from '@puddle/remote-transport';
import { readPrivateJson } from '@puddle/shared/node';
import { administrativeRequest } from './admin.js';
import { supervisorKind } from './supervisor.js';
import { DeviceStore } from './devices.js';

/** Host-side projection: no private configuration is ever returned to the cockpit. */
export async function inspectConnector(
  home: string,
  profile: string,
): Promise<CockpitRemoteStatus> {
  let supervisor: CockpitRemoteStatus['supervisor'] = null;
  try {
    supervisor = supervisorKind(home);
  } catch {
    // An externally supervised host can still inspect, revoke and disable.
  }
  const result: CockpitRemoteStatus = {
    availability: 'ready',
    configured: false,
    enabled: false,
    connected: false,
    supervisor,
    devices: [],
  };
  const directory = profileDirectory(home, profile);
  const path = join(directory, 'config.json');
  if (!existsSync(path)) return result;
  const config = connectorConfigSchema.parse(readPrivateJson(path));
  const status = await administrativeRequest(home, { t: 'status' }, profile);
  if (status.error) throw new Error('Could not inspect remote access');
  // Reset can leave a disabled process holding the old identity until restart.
  // Report the durable identity which the next enabled connector will use.
  const identityPath = join(directory, 'identity.json');
  const peer = existsSync(identityPath)
    ? identityPeer(Uint8Array.from(remoteIdentitySchema.parse(readPrivateJson(identityPath))))
    : undefined;
  if (existsSync(join(directory, 'devices.db'))) {
    const devices = new DeviceStore(directory);
    try {
      result.devices = devices.list();
    } finally {
      devices.close();
    }
  }
  return {
    ...result,
    configured: true,
    enabled: status.enabled ?? config.enabled,
    connected: status.connected ?? false,
    peer,
    host: config.host,
    service: config.service,
    app: config.app,
  };
}
