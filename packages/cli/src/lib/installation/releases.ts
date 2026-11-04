import { CliError } from '../types.js';
import { repoSlug } from '../version.js';
import { latestGitHubRelease } from '@puddle/shared/node/host-control';

/**
 * Release-version resolution for `puddle install`/`upgrade` (SPEC §10):
 * "newest" means the repository's latest published release, resolved
 * client-side so messages and pin warnings can name the version before any
 * installer runs. install.sh can resolve latest itself, but only after the
 * CLI has already committed to running it.
 */
export async function latestReleaseVersion(opts: { fetchFn?: typeof fetch } = {}): Promise<string> {
  const slug = repoSlug();
  if (slug === undefined) {
    throw new CliError(
      'not_installed',
      'no release source is configured for this build',
      'name a version and pass --tarball, or set PUDDLE_REPO=owner/repo',
    );
  }
  try {
    return (await latestGitHubRelease(slug, opts)).version;
  } catch (error) {
    throw new CliError(
      'not_installed',
      error instanceof Error ? error.message : 'Release lookup failed',
      'name a version explicitly, e.g. puddle install daemon@v0.0.32',
    );
  }
}
