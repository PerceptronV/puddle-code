import {
  canAdoptHuddle,
  type DaemonRuntimeCapabilities,
  type HostReleaseCapabilities,
  type HostUpdateCheckpoint,
} from '@puddle/shared';

/** Shared activation/recovery check against the exact outgoing daemon's drained state. */
export function requireCheckpointCompatibility(
  candidate: HostReleaseCapabilities,
  checkpoint: HostUpdateCheckpoint,
  roles?: DaemonRuntimeCapabilities | null,
): void {
  if (
    roles &&
    (roles.version !== candidate.version ||
      roles.application.major !== candidate.application.major ||
      roles.application.minor !== candidate.application.minor)
  )
    throw new Error('Daemon runtime capabilities do not match the candidate');
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
  if (
    checkpoint.owners.some(
      (owner) => owner.huddle && !canAdoptHuddle(roles, owner.huddle.capabilities),
    )
  )
    throw new Error('Candidate cannot adopt a checkpointed huddle');
}
