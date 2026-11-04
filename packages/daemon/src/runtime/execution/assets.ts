import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateJson, privateDirectory, privatePath } from '@puddle/shared/node';
import { runtimeAssetsSchema } from '@puddle/shared';

/** Runtime-owned copies outlive mutable account helper installations. */
export function pinRuntimeAssets(
  directory: string,
  sources: Readonly<Record<string, string>>,
): Record<string, string> {
  privatePath(directory, true);
  const files = Object.entries(sources);
  if (!files.length) return {};
  if (
    files.length > 16 ||
    files.some(
      ([name, source]) =>
        !/^[a-z0-9][a-z0-9-]*\.(mjs|js)$/.test(name) || Buffer.byteLength(source) > 512 * 1024,
    ) ||
    files.reduce((total, [, source]) => total + Buffer.byteLength(source), 0) > 1024 * 1024
  )
    throw new Error('Invalid runtime helper assets');
  const target = join(directory, 'helpers');
  if (existsSync(target)) throw new Error('Runtime helper assets are already pinned');
  const temporary = join(directory, `.helpers-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    const digests: Record<string, string> = {};
    for (const [name, source] of files) {
      const fd = openSync(join(temporary, name), 'wx', 0o400);
      try {
        writeFileSync(fd, source);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      digests[name] = createHash('sha256').update(source).digest('hex');
    }
    renameSync(temporary, target);
    const state = join(directory, 'hook-state');
    privateDirectory(state);
    const record = runtimeAssetsSchema.parse({
      format: 1,
      node_path: realpathSync(process.execPath),
      files: digests,
    });
    atomicPrivateJson(join(directory, 'assets.json'), record);
    return {
      PUDDLE_AGENT_HELPER_DIR: target,
      PUDDLE_AGENT_HELPER_NODE: record.node_path,
      PUDDLE_AGENT_TURN_STATE_DIR: state,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
