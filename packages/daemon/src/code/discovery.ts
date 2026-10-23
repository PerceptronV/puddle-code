import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const cache = new Map<string, { at: number; path: string | null }>();

/** PATH first, then bounded conventional user/package-manager installations. */
export function codeSearchDirectories(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
  return [
    ...new Set(
      [
        ...(env.PATH ?? '').split(delimiter),
        ...(env.VIRTUAL_ENV ? [join(env.VIRTUAL_ENV, 'bin')] : []),
        join(home, '.local', 'bin'),
        join(home, '.cargo', 'bin'),
        join(home, '.bun', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].filter((path) => isAbsolute(path)),
    ),
  ];
}

export function findCodeExecutable(
  names: readonly string[],
  directories = codeSearchDirectories(),
): string | null {
  const key = JSON.stringify([names, directories]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 30_000) return previous.path;
  let found: string | null = null;
  for (const name of names) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        found = candidate;
        break;
      } catch {
        // An absent or non-executable candidate cannot run this recipe.
      }
    }
    if (found) break;
  }
  if (cache.size >= 128) cache.clear();
  cache.set(key, { at: Date.now(), path: found });
  return found;
}
