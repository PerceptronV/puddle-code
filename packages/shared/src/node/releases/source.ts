import { releaseRepositorySchema } from './github.js';

declare const __PUDDLE_REPO_SLUG__: string | undefined;

/** Release builds embed their publishing repository; development may explicitly override it. */
export function releaseRepository(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value =
    env.PUDDLE_REPO ||
    (typeof __PUDDLE_REPO_SLUG__ === 'undefined' ? undefined : __PUDDLE_REPO_SLUG__);
  const parsed = releaseRepositorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
