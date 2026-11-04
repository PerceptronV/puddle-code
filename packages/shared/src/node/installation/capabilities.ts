import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  hostReleaseCapabilitiesSchema,
  hostStageReceiptSchema,
  type HostReleaseCapabilities,
  type HostStageReceipt,
} from '../../index.js';
import { digest, readPrivateJson } from '../security.js';

/** Inspect data only. Older executables may start a daemon for an unknown flag. */
export async function readStageCapabilities(
  home: string,
  input: HostStageReceipt,
): Promise<HostReleaseCapabilities> {
  const stage = hostStageReceiptSchema.parse(input);
  if (
    !stage.record.checksum_verified ||
    digest(`${JSON.stringify(stage.record)}\n`) !== stage.digest
  )
    throw new Error('Unverified host update stage');
  const versions = await realpath(join(home, 'bin/versions'));
  const root = await realpath(join(versions, stage.record.generation));
  if (dirname(root) !== versions || root !== join(versions, stage.record.generation))
    throw new Error('Host stage is outside its exact installed generation');
  const receipt = readPrivateJson(join(root, '.puddle-stage.json'), 4096);
  if (digest(`${JSON.stringify(receipt)}\n`) !== stage.digest)
    throw new Error('Host stage receipt changed');
  const capabilities = await readInstalledCapabilities(root);
  const protocol =
    stage.record.component === 'daemon' ? capabilities.application : capabilities.runtime;
  if (
    capabilities.version !== stage.record.version ||
    protocol.major !== stage.record.protocol.major ||
    protocol.minor !== stage.record.protocol.minor
  )
    throw new Error('Host capabilities do not match the staged component');
  return capabilities;
}

/** Bounded public release metadata, shared by staged and running-component inspection. */
export async function readInstalledCapabilities(root: string): Promise<HostReleaseCapabilities> {
  const file = await open(
    join(root, 'HOST_CAPABILITIES.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024)
      throw new Error('Invalid host capability metadata');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > stat.size) throw new Error('Host capability metadata changed during inspection');
    const capabilities = hostReleaseCapabilitiesSchema.parse(
      JSON.parse(buffer.subarray(0, size).toString('utf8')),
    );
    return capabilities;
  } finally {
    await file.close();
  }
}
