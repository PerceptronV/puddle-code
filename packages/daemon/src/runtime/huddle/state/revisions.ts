import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HUDDLE_REVISION_LIMITS, huddleRevisionSchema } from '@puddle/shared';
import {
  atomicPrivateJson,
  privateDirectory,
  privatePath,
  readPrivateJson,
  syncPrivateDirectory,
} from '@puddle/shared/node';
import { acquireHostClaim } from '../../../security/claims.js';
import { runtimeDirectory } from '../../ownership/storage.js';
import type { HuddleDefinitionSnapshot } from '../../../huddle/definitions/capture.js';
import { restoreHuddleDefinition } from '../../../huddle/definitions/restore.js';
import type { RuntimeByteAllowance } from '../../resources/budget.js';

/** Immutable content publication precedes the ledger's separate activation transaction. */
export class HuddleRevisionStore {
  private readonly directory: string;
  private readonly limits: { recordBytes: number; retainedBytes: number; records: number };
  constructor(
    private readonly home: string,
    private readonly runtimeId: string,
    private readonly huddleId: string,
    limits: Partial<{ recordBytes: number; retainedBytes: number; records: number }> = {},
    private readonly allowance?: RuntimeByteAllowance,
  ) {
    this.limits = { ...HUDDLE_REVISION_LIMITS, ...limits };
    for (const key of ['recordBytes', 'retainedBytes', 'records'] as const) {
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > HUDDLE_REVISION_LIMITS[key]
      )
        throw new Error('Invalid huddle revision limits');
    }
    this.directory = join(runtimeDirectory(home, runtimeId), 'huddle-revisions');
    privateDirectory(this.directory);
    syncPrivateDirectory(dirname(this.directory));
  }

  publish(snapshot: HuddleDefinitionSnapshot): HuddleDefinitionSnapshot {
    const document = {
      format: snapshot.format,
      digest: snapshot.digest,
      files: snapshot.files,
      components: snapshot.components,
    };
    const restored = restoreHuddleDefinition(document, this.huddleId);
    const encodedBytes = Buffer.byteLength(JSON.stringify(document)) + 1;
    if (encodedBytes > this.limits.recordBytes)
      throw new Error('Huddle revision record capacity exceeded');
    const claim = acquireHostClaim(this.home, `huddle-revisions:${this.runtimeId}`);
    try {
      try {
        return this.read(snapshot.digest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const entries = readdirSync(this.directory);
      if (entries.length >= this.limits.records)
        throw new Error('Huddle retained revision count exceeded');
      let bytes = encodedBytes;
      for (const name of entries) {
        const path = join(this.directory, name);
        privatePath(path);
        const stat = lstatSync(path);
        if (!stat.isFile()) throw new Error('Unexpected huddle revision entry');
        bytes += stat.size;
      }
      // Retain interrupted staging files too: they still occupy disk and are never mistaken for active source.
      if (bytes > this.limits.retainedBytes)
        throw new Error('Huddle retained revision bytes exceeded');
      atomicPrivateJson(this.path(snapshot.digest), document, { syncDirectory: true });
      return restored;
    } finally {
      claim.release();
    }
  }

  read(revision: string): HuddleDefinitionSnapshot {
    return readRetainedHuddleRevision(
      this.home,
      this.runtimeId,
      this.huddleId,
      revision,
      this.limits.recordBytes,
      this.allowance,
    );
  }

  private path(revision: string) {
    return join(this.directory, `${huddleRevisionSchema.parse(revision)}.json`);
  }
}

/** Observe existing source without creating directories or publishing a revision. */
export function readRetainedHuddleRevision(
  home: string,
  runtimeId: string,
  huddleId: string,
  revision: string,
  recordBytes: number = HUDDLE_REVISION_LIMITS.recordBytes,
  allowance?: RuntimeByteAllowance,
): HuddleDefinitionSnapshot {
  const directory = join(runtimeDirectory(home, runtimeId), 'huddle-revisions');
  privatePath(directory, true);
  const path = join(directory, `${huddleRevisionSchema.parse(revision)}.json`);
  privatePath(path);
  const size = lstatSync(path).size;
  if (size > Math.min(recordBytes, HUDDLE_REVISION_LIMITS.recordBytes))
    throw new Error('Huddle revision record capacity exceeded');
  const release = allowance?.reserve(8 * size + 64 * 1024);
  if (allowance && !release)
    throw new Error('Host memory admission is unavailable for huddle source');
  try {
    // A replacement/growing file cannot exceed the admitted read workspace.
    const snapshot = restoreHuddleDefinition(readPrivateJson(path, size), huddleId);
    if (snapshot.digest !== revision)
      throw new Error('Retained huddle revision differs from its requested digest');
    return snapshot;
  } finally {
    release?.();
  }
}
