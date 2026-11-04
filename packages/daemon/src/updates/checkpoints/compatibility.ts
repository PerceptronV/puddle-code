import type { HostReleaseCapabilities, HostUpdateCheckpoint } from '@puddle/shared';

/** Shared activation/recovery check against the exact outgoing daemon's drained state. */
export function requireCheckpointCompatibility(
  candidate: HostReleaseCapabilities,
  checkpoint: HostUpdateCheckpoint,
): void {
  if (
    candidate.database_schema_version === undefined ||
    candidate.database_schema_version < checkpoint.daemon.schema_version
  )
    throw new Error('Candidate cannot open the checkpointed application database');
  if (
    checkpoint.owners.some(
      (owner) => !candidate.supported_runtime_majors.includes(owner.protocol.major),
    )
  )
    throw new Error('Candidate cannot adopt a checkpointed runtime');
}
