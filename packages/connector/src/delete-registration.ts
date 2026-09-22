import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connectorConfigSchema } from '@puddle/shared';
import { atomicPrivateJson, readPrivateJson } from '@puddle/shared/node';
import { DeviceStore } from './devices.js';
import { retireRegistration } from './registration-cleanup.js';

/** Disable durably before revocation/removal; retain the identity and revoked audit records. */
export function deleteRegistration(directory: string, liveDevices?: DeviceStore): void {
  const path = join(directory, 'config.json');
  if (existsSync(path)) {
    const config = connectorConfigSchema.parse(readPrivateJson(path));
    atomicPrivateJson(path, { ...config, enabled: false });
    retireRegistration(directory, config);
  }
  const devices =
    liveDevices ??
    (existsSync(join(directory, 'devices.db')) ? new DeviceStore(directory) : undefined);
  try {
    devices?.revokeAll();
    rmSync(path, { force: true });
  } finally {
    if (!liveDevices) devices?.close();
  }
}
