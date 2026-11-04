import { totalmem } from 'node:os';
import { RUNTIME_LIMITS } from '@puddle/shared';

const MIB = 1024 * 1024;
export const HOST_MEMORY_CHUNK_BYTES = 4 * MIB;
export const HOST_MEMORY_SPARE_BYTES = MIB;

/** Persist once; subsequent opens use the sealed capacity, never current free memory. */
export function initialHostMemoryCapacity(
  physicalBytes = totalmem(),
  constrainedBytes = process.constrainedMemory(),
): number {
  if (!Number.isSafeInteger(physicalBytes) || physicalBytes < MIB)
    throw new Error('Host memory capacity is unavailable');
  const effective =
    Number.isSafeInteger(constrainedBytes) && constrainedBytes > 0
      ? Math.min(physicalBytes, constrainedBytes)
      : physicalBytes;
  return Math.max(MIB, Math.floor(Math.min(8 * 1024 * MIB, effective / 4) / MIB) * MIB);
}

/**
 * Common managed state: journal generations/encoding/page work (24 MiB),
 * captured environment (8 MiB), and bounded metadata/OSC carries (8 MiB).
 * Launch bytes additionally cover parsed/encoded startup copies. Major bulk
 * domains reserve separately. These charged units are not an RSS guarantee.
 */
export function runtimeEssentialMemoryBytes(launchBytes: number): number {
  if (
    !Number.isSafeInteger(launchBytes) ||
    launchBytes <= 0 ||
    launchBytes > RUNTIME_LIMITS.frameBytes
  )
    throw new Error('Invalid runtime launch memory charge');
  return 40 * MIB + 8 * launchBytes;
}
