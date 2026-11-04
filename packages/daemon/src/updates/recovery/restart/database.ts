import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  HOST_UPDATE_CHECKPOINT_OWNERS,
  runtimeLaunchSchema,
  runtimeStateSchema,
  type HostReleaseCapabilities,
  type HostUpdateCheckpoint,
} from '@puddle/shared';
import { digest, privatePath } from '@puddle/shared/node';
import { DATABASE_SCHEMA_VERSION } from '../../../db/migrations/index.js';
import { RuntimeStore } from '../../../db/stores/runtimes.js';
import { readRuntimeJson } from '../../../runtime/ownership/storage.js';
import { runtimeBindingIdentity } from '../../../runtime/transport/connections.js';
import { inspectRuntimeInventory } from '../../preflight/compatibility.js';
import { requireCheckpointCompatibility } from '../../checkpoints/compatibility.js';
import { runtimeCheckpointOwner } from '../../checkpoints/store.js';

/** Caller holds the controller claim. Read current committed WAL data; never migrate or restore it. */
export async function inspectRecoveryDatabase(
  home: string,
  candidate: HostReleaseCapabilities,
  checkpoint: HostUpdateCheckpoint,
) {
  requireCheckpointCompatibility(candidate, checkpoint);
  const path = join(home, 'puddle.db');
  const stat = lstatSync(path);
  // Legacy application databases may be readable; the containing home is private.
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new Error('Unsafe application database during recovery');
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    db.exec('BEGIN');
    const schema = db.pragma('user_version', { simple: true }) as number;
    if (
      !Number.isSafeInteger(schema) ||
      schema < checkpoint.daemon.schema_version ||
      schema > DATABASE_SCHEMA_VERSION ||
      schema > candidate.database_schema_version!
    )
      throw new Error(
        'Current database schema is not supported by this recovery worker and candidate',
      );
    const runtimes = new RuntimeStore(db);
    const rows = runtimes.live(HOST_UPDATE_CHECKPOINT_OWNERS + 1);
    if (rows.length > HOST_UPDATE_CHECKPOINT_OWNERS)
      throw new Error('Recovery runtime inventory exceeds its limit');
    const known = new Set(rows.map(({ runtime_id }) => runtime_id));
    if ((await inspectRuntimeInventory(home, runtimes, known)).length)
      throw new Error('Recovery runtime inventory is unknown');
    for (const previous of checkpoint.owners) {
      const row = runtimes.get(previous.identity.runtime_id);
      if (
        !row ||
        JSON.stringify(runtimeBindingIdentity(row)) !== JSON.stringify(previous.identity) ||
        row.build !== previous.build ||
        row.protocol_major !== previous.protocol.major ||
        row.protocol_minor !== previous.protocol.minor ||
        row.release_path !== previous.release_path ||
        row.launch_fingerprint !== previous.launch_fingerprint ||
        row.event_cursor < previous.event_cursor ||
        row.state === 'interrupted' ||
        (['exited', 'failed'].includes(previous.state) && row.state !== previous.state)
      )
        throw new Error('Current database lost checkpointed runtime state');
    }
    for (const row of rows) {
      if (!candidate.supported_runtime_majors.includes(row.protocol_major))
        throw new Error('Candidate cannot adopt a current runtime');
      const directory = join(home, 'runtimes', row.runtime_id);
      privatePath(directory, true);
      const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
      const identity = runtimeBindingIdentity(row);
      if (JSON.stringify(launch.identity) !== JSON.stringify(identity))
        throw new Error('Current runtime launch identity changed');
      try {
        const state = runtimeStateSchema.parse(readRuntimeJson(join(directory, 'state.json')));
        if (
          JSON.stringify(state.identity) !== JSON.stringify(identity) ||
          state.build !== row.build ||
          state.protocol.major !== row.protocol_major ||
          state.protocol.minor !== row.protocol_minor
        )
          throw new Error('Current runtime state identity changed');
      } catch (error) {
        if (row.state !== 'prepared' || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error;
      }
    }
    return {
      schema,
      inventory: digest(JSON.stringify(rows)),
      owners: rows.map(runtimeCheckpointOwner),
    };
  } finally {
    db.close();
  }
}
