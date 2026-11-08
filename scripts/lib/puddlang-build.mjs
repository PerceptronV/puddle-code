import { join } from 'node:path';

/** Keep runtime helpers and their relative SDK imports identical in archives and fixtures. */
export function puddlangEntryPoints(repoRoot) {
  return Object.fromEntries([
    ...['runner', 'runtime-api', 'zod'].map((name) => [
      name,
      join(repoRoot, `packages/daemon/src/puddlang/${name}.ts`),
    ]),
    ...['runner', 'sdk'].map((name) => [
      `huddle/${name}`,
      join(repoRoot, `packages/daemon/src/runtime/huddle/workers/${name}.ts`),
    ]),
  ]);
}
