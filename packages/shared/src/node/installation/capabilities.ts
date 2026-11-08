import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  hostReleaseCapabilitiesSchema,
  daemonRuntimeCapabilitiesSchema,
  type DaemonRuntimeCapabilities,
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
  return hostReleaseCapabilitiesSchema.parse(await readMetadata(root, 'HOST_CAPABILITIES.json'));
}

/** Absent on historical releases; malformed or mismatched metadata is never support. */
export async function readStageDaemonRuntimeCapabilities(
  home: string,
  input: HostStageReceipt,
): Promise<DaemonRuntimeCapabilities | null> {
  const stage = hostStageReceiptSchema.parse(input);
  if (stage.record.component !== 'daemon') throw new Error('Expected a daemon stage');
  const host = await readStageCapabilities(home, stage);
  const root = join(home, 'bin', 'versions', stage.record.generation);
  let raw: unknown;
  try {
    raw = await readMetadata(root, 'DAEMON_RUNTIME_CAPABILITIES.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = daemonRuntimeCapabilitiesSchema.parse(raw);
  if (
    value.version !== host.version ||
    value.application.major !== host.application.major ||
    value.application.minor !== host.application.minor
  )
    throw new Error('Daemon runtime capabilities do not match the staged daemon');
  return value;
}

async function readMetadata(root: string, name: string): Promise<unknown> {
  const file = await open(
    join(root, name),
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
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally {
    await file.close();
  }
}
