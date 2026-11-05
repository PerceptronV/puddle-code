import {
  releaseManifestSchema,
  releaseVersionSchema,
  type ReleaseComponent,
  type ReleaseManifest,
} from '../../installation/release-manifest.js';
import { releaseRepositorySchema } from '../../installation/catalogue.js';
import { githubRelease, latestGitHubRelease, type ReleaseAsset } from './github.js';

type Options = { fetchFn?: typeof fetch; signal?: AbortSignal };
type Release = { version: string; assets: ReleaseAsset[] };
export const RELEASE_MANIFEST_ASSET = 'release-manifest.json';

/** Absence alone means a legacy all-component release. Corrupt/unavailable metadata never falls back. */
export async function releaseManifest(
  repository: string,
  release: Release,
  options: Options = {},
): Promise<ReleaseManifest> {
  releaseRepositorySchema.parse(repository);
  releaseVersionSchema.parse(release.version);
  const legacy = {
    format: 1,
    version: release.version,
    components: { cockpit: release.version, daemon: release.version, runtime: release.version },
  };
  if (!release.assets.some((asset) => asset.name === RELEASE_MANIFEST_ASSET))
    return releaseManifestSchema.parse(legacy);
  const response = await (options.fetchFn ?? fetch)(
    `https://github.com/${repository}/releases/download/v${release.version}/${RELEASE_MANIFEST_ASSET}`,
    {
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Release manifest is unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) throw new Error('Release manifest exceeds its limit');
      chunks.push(value);
    }
    const manifest = releaseManifestSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    if (manifest.version !== release.version) throw new Error('Release manifest tag mismatch');
    return manifest;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One latest lookup and at most two older tag lookups; no unbounded release-history search. */
export async function latestComponentReleases(repository: string, options: Options = {}) {
  const latest = await latestGitHubRelease(repository, options);
  const manifest = await releaseManifest(repository, latest, options);
  const versions = new Map<string, Release>([[latest.version, latest]]);
  for (const version of new Set(Object.values(manifest.components))) {
    if (versions.has(version)) continue;
    const release = await githubRelease(repository, `tags/v${version}`, options);
    if (release.version !== version) throw new Error('Component release tag mismatch');
    versions.set(version, release);
  }
  for (const component of ['daemon', 'runtime'] as const) {
    const version = manifest.components[component];
    if (version === latest.version) continue;
    const target = versions.get(version)!;
    const targetManifest = await releaseManifest(repository, target, options);
    if (targetManifest.components[component] !== version)
      throw new Error(`Manifest refers to an unpublished ${component}`);
  }
  return {
    version: latest.version,
    components: {
      cockpit: versions.get(manifest.components.cockpit)!,
      daemon: versions.get(manifest.components.daemon)!,
      runtime: versions.get(manifest.components.runtime)!,
    },
  };
}

export async function componentReleaseAt(
  repository: string,
  component: ReleaseComponent,
  version: string,
  options: Options = {},
) {
  releaseVersionSchema.parse(version);
  const release = await githubRelease(repository, `tags/v${version}`, options);
  if (release.version !== version) throw new Error('Component release tag mismatch');
  const manifest = await releaseManifest(repository, release, options);
  if (manifest.components[component] !== version)
    throw new Error(
      `No ${component} was published for v${version}; this release uses v${manifest.components[component]}`,
    );
  return { ...release, manifest };
}
