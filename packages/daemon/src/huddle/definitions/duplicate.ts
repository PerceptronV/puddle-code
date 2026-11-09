import { mkdirSync, writeFileSync } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { HUDDLE_LIMITS, huddleDefinitionSchema } from '@puddle/shared';
import { ApiError } from '../../http/errors.js';
import { checkedHuddlePath, readHuddleFile } from './files.js';
import { createHuddleDirectory } from './create.js';
import type { HuddleDefinitionSnapshot } from './capture.js';

interface SourceTree {
  files: Record<string, string>;
  directories: string[];
}

/** Include README/fixtures and unused components, without importing source or following links. */
async function readTree(root: string): Promise<SourceTree> {
  const files: Record<string, string> = Object.create(null);
  const directories: string[] = [];
  const pending = [''];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    const path = relative ? await checkedHuddlePath(root, relative) : root;
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++entries > HUDDLE_LIMITS.files * 2)
        throw new Error('Huddle copy exceeds 256 source entries');
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await checkedHuddlePath(root, child);
        directories.push(child);
        pending.push(child);
      } else {
        if (!entry.isFile()) throw new Error(`Huddle copy requires ordinary files: ${child}`);
        if (Object.keys(files).length >= HUDDLE_LIMITS.files)
          throw new Error('Huddle copy exceeds 128 source files');
        const text = await readHuddleFile(root, child);
        bytes += Buffer.byteLength(text);
        if (bytes > HUDDLE_LIMITS.bundleBytes)
          throw new Error('Huddle copy exceeds 4 MiB of source');
        files[child] = text;
      }
    }
  }
  return {
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    directories: directories.sort(),
  };
}

export async function captureHuddleCopy(worktree: string, snapshot: HuddleDefinitionSnapshot) {
  const root = await checkedHuddlePath(worktree, `.puddle/huddle/${snapshot.definition.id}`);
  const before = await lstat(root);
  const copy = await readTree(root);
  if (copy.files['layout.json'] !== snapshot.files['layout.json'])
    throw ApiError.conflict('huddle_source_changed', 'Huddle layout changed before copying');
  for (const [path, text] of Object.entries(snapshot.files)) {
    if (copy.files[path] !== text)
      throw ApiError.conflict('huddle_source_changed', 'Huddle source changed before copying');
  }
  const verified = await readTree(root);
  const after = await lstat(
    await checkedHuddlePath(worktree, `.puddle/huddle/${snapshot.definition.id}`),
  );
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    JSON.stringify(copy) !== JSON.stringify(verified)
  )
    throw ApiError.conflict('huddle_source_changed', 'Huddle files changed while copying');
  return copy;
}

/** Publish only the captured text. A later failure leaves files discoverable, never retries. */
export function publishHuddleCopy(worktree: string, name: string, copy: SourceTree) {
  const original = JSON.parse(copy.files['huddle.json']!);
  huddleDefinitionSchema.parse(original);
  const next = { ...original, name };
  const spacing =
    Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') <= HUDDLE_LIMITS.fileBytes ? 2 : 0;
  const size = Buffer.byteLength(JSON.stringify(next, null, spacing) + '\n');
  if (
    size > HUDDLE_LIMITS.fileBytes ||
    Object.values(copy.files).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) -
      Buffer.byteLength(copy.files['huddle.json']!) +
      size >
      HUDDLE_LIMITS.bundleBytes
  )
    throw new Error('Copied huddle manifest exceeds the source limits');
  const { id, root } = createHuddleDirectory(worktree);
  for (const directory of copy.directories) mkdirSync(join(root, directory));
  for (const [path, text] of Object.entries(copy.files)) {
    if (path !== 'huddle.json') writeFileSync(join(root, path), text, { flag: 'wx', flush: true });
  }
  // Change only the top-level identity/name, preserving explicit parameters and other source.
  writeFileSync(join(root, 'huddle.json'), JSON.stringify({ ...next, id }, null, spacing) + '\n', {
    flag: 'wx',
    flush: true,
  });
  return id;
}
