import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentLaunchError } from './launch-error.js';

const execFileAsync = promisify(execFile);
type Version = readonly [number, number, number];
const checks = new Map<string, { at: number; version: Promise<Version | null> }>();
const CACHE_MS = 30_000;

/** Cached, bounded CLI-version capability probe used before hook launches. */
export async function lifecycleVersionAtLeast(
  binary: string,
  args: string[],
  minimum: readonly [number, number, number],
  environment?: Record<string, string>,
  requireVersion = false,
): Promise<boolean> {
  const env = environment ? { ...process.env, ...environment } : process.env;
  const environmentKey = createHash('sha256')
    .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  const key = `${environmentKey}\0${binary}\0${args.join('\0')}`;
  let check = checks.get(key);
  if (!check || Date.now() - check.at >= CACHE_MS) {
    const version = execFileAsync(binary, args, {
      env,
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 64 * 1024,
    })
      .then(({ stdout, stderr }): Version | null => {
        const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${String(stdout)}\n${String(stderr)}`);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
      })
      .catch(() => null);
    // Share the observation across capability floors, including concurrent callers.
    // Expire observations so replacing a CLI does not require a daemon restart.
    if (checks.size >= 64) checks.delete(checks.keys().next().value!);
    check = { at: Date.now(), version };
    checks.set(key, check);
  }
  const found = await check.version;
  if (!found) {
    if (requireVersion)
      throw new AgentLaunchError(
        `Cannot verify ${binary} version; refusing a launch that may use an unowned background server`,
      );
    return false;
  }
  for (let index = 0; index < minimum.length; index++) {
    if (found[index]! > minimum[index]!) return true;
    if (found[index]! < minimum[index]!) return false;
  }
  return true;
}
