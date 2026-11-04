import { lstatSync, realpathSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { hostStageRecordSchema, parseHostReleaseVersion } from '@puddle/shared';
import { digest, privatePath, readPrivateJson } from '@puddle/shared/node';

export const RELEASE_INVENTORY_LIMIT = 4096;
export const UNREFERENCED_RELEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RetainedRelease {
  path: string;
  generation: string;
  device: number;
  inode: number;
  receipt: string | null;
  publishedAt: number | null;
  references: string[];
}

/** Metadata only. A review is not authority to delete files or to retire a reference. */
export class ReleaseReferenceInventory {
  readonly versions: string;
  private readonly releases = new Map<string, RetainedRelease>();
  constructor(
    readonly home: string,
    readonly requireCurrent: () => void,
  ) {
    requireCurrent();
    privatePath(join(home, 'bin'), true);
    ownedDirectory(join(home, 'bin/versions'));
    this.versions = realpathSync(join(home, 'bin/versions'));
  }

  async inspect(): Promise<void> {
    for (const generation of await boundedDirectories(this.versions, this.requireCurrent, false)) {
      if (
        !hostStageRecordSchema.shape.generation.safeParse(generation).success &&
        parseHostReleaseVersion(generation) !== generation
      )
        throw new Error('Unknown installed release generation');
      const path = join(this.versions, generation);
      const info = lstatSync(path);
      const value = optionalRecord(join(path, '.puddle-stage.json'), 4096);
      const record = value === null ? null : hostStageRecordSchema.parse(value);
      if (record && record.generation !== generation)
        throw new Error('Release receipt belongs to another generation');
      this.releases.set(path, {
        path,
        generation,
        device: info.dev,
        inode: info.ino,
        receipt: record ? digest(`${JSON.stringify(record)}\n`) : null,
        publishedAt: record ? lstatSync(join(path, '.puddle-stage.json')).mtimeMs : null,
        references: record?.checksum_verified ? [] : ['unverified-release'],
      });
    }
  }

  add(path: string, reference: string): void {
    this.requireCurrent();
    if (!isAbsolute(path)) throw new Error('Release reference is not absolute');
    const canonical = realpathSync(path);
    if (dirname(canonical) !== this.versions || !this.releases.has(canonical))
      throw new Error('Release reference is outside the inspected inventory');
    ownedDirectory(path);
    const release = this.releases.get(canonical)!;
    if (!release.references.includes(reference)) release.references.push(reference);
  }

  executable(path: string, reference: string): void {
    if (!isAbsolute(path) || realpathSync(path) !== path || !lstatSync(path).isFile())
      throw new Error('Pinned executable is missing or indirect');
    this.add(dirname(dirname(path)), reference);
  }

  finish(now: number) {
    this.requireCurrent();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid collection review time');
    const releases = [...this.releases.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const release of releases) release.references.sort();
    const candidates = releases
      .filter(
        (release) =>
          !release.references.length &&
          release.publishedAt !== null &&
          release.publishedAt <= now - UNREFERENCED_RELEASE_RETENTION_MS,
      )
      .map(({ path }) => path);
    return { fingerprint: digest(JSON.stringify({ releases, candidates })), releases, candidates };
  }
}

function ownedDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new Error('Unsafe installed release directory');
}

export function optionalRecord(path: string, limit: number): unknown | null {
  try {
    return readPrivateJson(path, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Yield between bounded entries; never follow a directory link or silently truncate a scan. */
export async function boundedDirectories(
  path: string,
  requireCurrent: () => void,
  privateStorage = true,
): Promise<string[]> {
  return boundedEntries(path, requireCurrent, 'directory', privateStorage);
}

export async function boundedFiles(path: string, requireCurrent: () => void): Promise<string[]> {
  return boundedEntries(path, requireCurrent, 'file', true);
}

async function boundedEntries(
  path: string,
  requireCurrent: () => void,
  kind: 'directory' | 'file',
  privateStorage: boolean,
): Promise<string[]> {
  try {
    if (privateStorage) privatePath(path, true);
    else ownedDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: string[] = [];
  for await (const entry of await opendir(path)) {
    requireCurrent();
    if (
      !(kind === 'directory' ? entry.isDirectory() : entry.isFile()) ||
      result.length === RELEASE_INVENTORY_LIMIT
    )
      throw new Error('Unknown or excessive reference inventory');
    const directory = join(path, entry.name);
    if (privateStorage) privatePath(directory, kind === 'directory');
    else ownedDirectory(directory);
    result.push(entry.name);
  }
  return result.sort();
}
