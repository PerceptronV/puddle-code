import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Shared by the standalone CLI and daemon distributions. */
export const NODE_RUNTIME_VERSION = '22.21.1';
const fail = (message) => {
  throw new Error(message);
};

/** Fetch and cache the pinned runtime; ship only bin/node. */
export async function stageNodeRuntime(repoRoot, stage, target, log = console.log) {
  const cacheDir = join(repoRoot, 'node_modules', '.cache', 'puddle-node-runtime');
  const distName = `node-v${NODE_RUNTIME_VERSION}-${target}`;
  const cachedNode = join(cacheDir, distName, 'bin', 'node');

  if (!existsSync(cachedNode)) {
    mkdirSync(cacheDir, { recursive: true });
    const base = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
    const tarName = `${distName}.tar.gz`;
    const tarPath = join(cacheDir, tarName);
    log(`downloading ${base}/${tarName}`);
    const res = await fetch(`${base}/${tarName}`);
    if (!res.ok || res.body === null) fail(`node download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));

    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const expected = sums
      .split('\n')
      .find((line) => line.endsWith(`  ${tarName}`))
      ?.split(/\s+/)[0];
    if (expected === undefined) fail(`SHASUMS256.txt has no entry for ${tarName}`);
    const actual = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
    if (actual !== expected) fail(`checksum mismatch for ${tarName}`);

    execFileSync('tar', ['-xzf', tarPath, '-C', cacheDir, `${distName}/bin/node`]);
    rmSync(tarPath);
  }

  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(cachedNode, join(stage, 'bin', 'node'));
  chmodSync(join(stage, 'bin', 'node'), 0o755);
  log(`staged node v${NODE_RUNTIME_VERSION} (${(statSync(cachedNode).size / 1e6).toFixed(0)} MB)`);
}
