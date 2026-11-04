import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_REMOVAL_SERVICES_BYTES, hostRemovalServicesSchema } from '@puddle/shared';
import { privatePath, readPrivateJson } from '@puddle/shared/node';
import { inspectHostRemoval, validateHostRemovalServices } from '@puddle/shared/node/host-control';
import { disableAllProfiles } from './disable.js';

/** Explicit continuation of one accepted removal; never grants configuration/startup authority. */
export async function continueRemovalDisable(home: string, id: string): Promise<void> {
  hostRemovalServicesSchema.shape.id.parse(id);
  const read = () => {
    const status = inspectHostRemoval(home);
    if (status.state !== 'removing' || status.id !== id)
      throw new Error('Remote disable continuation requires the exact active removal');
    privatePath(join(home, 'installation/removal'), true);
    const record = validateHostRemovalServices(
      readPrivateJson(
        join(home, 'installation/removal/services.json'),
        HOST_REMOVAL_SERVICES_BYTES,
      ),
    );
    if (
      record.id !== id ||
      record.actions[0]?.action !== 'disable-remote' ||
      record.actions[0].state !== 'started' ||
      record.release_path !== realpathSync(join(home, 'bin/current'))
    )
      throw new Error('Remote disable continuation is not the recorded active step');
    return JSON.stringify(record);
  };
  const accepted = read();
  // Enablement/re-registration is fenced by this record. Disabled profiles are
  // observed and synced; only profiles still enabled enter ordinary disablement.
  await disableAllProfiles(home, () => {
    if (read() !== accepted) throw new Error('Remote disable removal evidence changed');
  });
}
