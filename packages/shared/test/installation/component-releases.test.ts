import { expect, it, vi } from 'vitest';
import { componentReleaseAt, latestComponentReleases } from '../../src/node/releases/components.js';
import { releaseManifestSchema } from '../../src/installation/release-manifest.js';

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/example/puddle/${name}`,
});
const release = (version: string, manifest = false) => ({
  tag_name: `v${version}`,
  assets: [
    asset(`puddled-v${version}-linux-x64.tar.gz`),
    asset('SHA256SUMS'),
    ...(manifest ? [asset('release-manifest.json')] : []),
  ],
});
const plan = {
  format: 1,
  version: '0.4.10',
  components: { cockpit: '0.4.10', daemon: '0.4.8', runtime: '0.4.5' },
};
const response = (value: unknown) => new Response(JSON.stringify(value));
function fixture(manifest: unknown = plan) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/latest')) return response(release('0.4.10', true));
    if (url.endsWith('/release-manifest.json')) return response(manifest);
    if (url.endsWith('/tags/v0.4.8')) return response(release('0.4.8'));
    if (url.endsWith('/tags/v0.4.5')) return response(release('0.4.5'));
    if (url.endsWith('/tags/v0.4.10')) return response(release('0.4.10', true));
    throw new Error(`Unexpected URL ${url}`);
  });
}
it('resolves each component without inventing skipped versions or scanning release history', async () => {
  const fetchFn = fixture();
  const result = await latestComponentReleases('example/puddle', { fetchFn });
  expect(result.components.daemon.version).toBe('0.4.8');
  expect(result.components.runtime.version).toBe('0.4.5');
  expect(result.components.cockpit.version).toBe('0.4.10');
  expect(fetchFn).toHaveBeenCalledTimes(4);
});
it('reads pre-manifest releases unchanged with one request', async () => {
  const fetchFn = vi.fn(async () => response(release('0.4.8')));
  const result = await latestComponentReleases('example/puddle', { fetchFn });
  expect(result.components.daemon.version).toBe('0.4.8');
  expect(result.components.runtime.version).toBe('0.4.8');
  expect(fetchFn).toHaveBeenCalledOnce();
});
it('rejects an explicit skipped component version instead of substituting another build', async () => {
  await expect(
    componentReleaseAt('example/puddle', 'daemon', '0.4.10', { fetchFn: fixture() }),
  ).rejects.toThrow('No daemon was published');
});
it.each([
  { ...plan, format: 2 },
  { ...plan, version: '0.4.9' },
  { ...plan, components: { ...plan.components, daemon: '0.4.11' } },
  { ...plan, components: { ...plan.components, daemon: '../private' } },
  { ...plan, components: { cockpit: '0.4.10', daemon: '0.4.8' } },
])('does not treat invalid manifests as legacy releases %#', async (manifest) => {
  await expect(
    latestComponentReleases('example/puddle', { fetchFn: fixture(manifest) }),
  ).rejects.toThrow();
});
it('does not fall back after an advertised manifest fails to download', async () => {
  const fetchFn = fixture();
  fetchFn
    .mockImplementationOnce(async () => response(release('0.4.10', true)))
    .mockImplementationOnce(async () => new Response('', { status: 404 }));
  await expect(latestComponentReleases('example/puddle', { fetchFn })).rejects.toThrow(
    'unavailable',
  );
});
it('rejects malformed versions without throwing outside safeParse', () => {
  expect(
    releaseManifestSchema.safeParse({
      ...plan,
      components: { ...plan.components, runtime: 'invalid' },
    }).success,
  ).toBe(false);
});

it('suppresses component metadata for old strict catalogue readers', async () => {
  const { presentHostCatalogue, hostReleaseCheckSchema } =
    await import('../../src/installation/catalogue.js');
  const catalogue = {
    observed_at: 1,
    daemon_version: '0.4.8',
    runtime_default: null,
    runtimes: { complete: true, versions: [] },
    releases: {
      repository: 'example/puddle',
      state: 'ready' as const,
      checked_at: 1,
      succeeded_at: 1,
      latest: { version: '0.4.10', host_asset: false },
      components: {
        daemon: { version: '0.4.8', host_asset: true },
        runtime: { version: '0.4.5', host_asset: true },
      },
    },
  };
  const old = presentHostCatalogue(catalogue);
  expect(hostReleaseCheckSchema.omit({ components: true }).safeParse(old.releases).success).toBe(
    true,
  );
  expect(old.releases.latest?.host_asset).toBe(false);
  expect(presentHostCatalogue(catalogue, true).releases.components).toEqual(
    catalogue.releases.components,
  );
});
