import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentLaunchError } from './launch-error.js';
import {
  readVersionObservation,
  versionExecutableIdentity,
  VERSION_CACHE_MS,
  writeVersionObservation,
  type CliVersion,
} from './version-cache.js';

const execFileAsync = promisify(execFile);
const checks = new Map<
  string,
  { at: number; observed: boolean; version: Promise<CliVersion | null> }
>();

/** Cached, bounded CLI-version capability probe used before hook launches. */
export async function lifecycleVersionAtLeast(
  binary: string,
  args: string[],
  minimum: readonly [number, number, number],
  environment?: Record<string, string>,
  requireVersion = false,
  cacheDirectory?: string,
): Promise<boolean> {
  const env = { ...process.env, ...environment };
  // Version commands do not execute managed hooks. Keep runtime-specific paths
  // and nonces out of both the probe and its key; retain PATH and all CLI options.
  for (const key of [
    'PUDDLE_AGENT_HELPER_DIR',
    'PUDDLE_AGENT_HELPER_NODE',
    'PUDDLE_AGENT_TURN_STATE_DIR',
    'PUDDLE_AGENT_SIGNAL_URL',
    'PUDDLE_AGENT_SIGNAL_NONCE',
  ])
    delete env[key];
  const environmentKey = createHash('sha256')
    .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  const identity = versionExecutableIdentity(binary, env);
  const key = createHash('sha256')
    .update(JSON.stringify([environmentKey, binary, args, identity]))
    .digest('hex');
  let check = checks.get(key);
  if (
    !check ||
    (requireVersion && !check.observed) ||
    Date.now() < check.at ||
    Date.now() - check.at >= VERSION_CACHE_MS
  ) {
    // Persistent observations are optional capabilities, never ownership admission.
    const cached =
      cacheDirectory && identity && !requireVersion
        ? readVersionObservation(cacheDirectory, key)
        : null;
    const version = cached
      ? Promise.resolve(cached.version)
      : execFileAsync(binary, args, {
          env,
          encoding: 'utf8',
          timeout: 3_000,
          maxBuffer: 64 * 1024,
        })
          .then(({ stdout, stderr }): CliVersion | null => {
            const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${String(stdout)}\n${String(stderr)}`);
            const found: CliVersion | null = match
              ? [Number(match[1]), Number(match[2]), Number(match[3])]
              : null;
            if (
              found &&
              cacheDirectory &&
              identity &&
              !requireVersion &&
              versionExecutableIdentity(binary, env) === identity
            )
              writeVersionObservation(cacheDirectory, key, found);
            return found;
          })
          .catch(() => null);
    // Share the observation across capability floors, including concurrent callers.
    // Expire observations so replacing a CLI does not require a daemon restart.
    if (checks.size >= 64) checks.delete(checks.keys().next().value!);
    check = { at: cached?.at ?? Date.now(), observed: !cached, version };
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
