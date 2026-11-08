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

/** Immutable content publication precedes the ledger's separate activation transaction. */
export class HuddleRevisionStore {
  private readonly directory: string;
  private readonly limits: { recordBytes: number; retainedBytes: number; records: number };
  constructor(
    private readonly home: string,
    private readonly runtimeId: string,
    private readonly huddleId: string,
    limits: Partial<{ recordBytes: number; retainedBytes: number; records: number }> = {},
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
    return restoreHuddleDefinition(
      readPrivateJson(this.path(revision), this.limits.recordBytes),
      this.huddleId,
    );
  }

  private path(revision: string) {
    return join(this.directory, `${huddleRevisionSchema.parse(revision)}.json`);
  }
}
