import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const checks = new Map<string, Promise<boolean>>();

/** Cached, bounded CLI-version capability probe used before hook launches. */
export function lifecycleVersionAtLeast(
  binary: string,
  args: string[],
  minimum: readonly [number, number, number],
  environment?: Record<string, string>,
): Promise<boolean> {
  const env = environment ? { ...process.env, ...environment } : process.env;
  const environmentKey = createHash('sha256')
    .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
  const key = `${environmentKey}\0${binary}\0${args.join('\0')}\0${minimum.join('.')}`;
  const active = checks.get(key);
  if (active) return active;
  const check = execFileAsync(binary, args, {
    env,
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 64 * 1024,
  })
    .then(({ stdout, stderr }) => {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${String(stdout)}\n${String(stderr)}`);
      if (!match) return false;
      const found = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
      for (let index = 0; index < minimum.length; index++) {
        if (found[index]! > minimum[index]!) return true;
        if (found[index]! < minimum[index]!) return false;
      }
      return true;
    })
    .catch(() => false);
  // Captured launch environments can vary for every session in a legacy daemon.
  if (checks.size >= 64) checks.delete(checks.keys().next().value!);
  checks.set(key, check);
  return check;
}
