import { expect, it, vi } from 'vitest';
import { isNewerVersion } from '../../src/index.js';
import { latestGitHubRelease } from '../../src/node/releases/github.js';
import { releaseRepository } from '../../src/node/releases/source.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

it('keeps the embedded publishing repository when the shared helper is bundled', async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../src/node/releases/source.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    define: { __PUDDLE_REPO_SLUG__: JSON.stringify('example/published') },
  });
  const built = (await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.text).toString('base64')}`
  )) as {
    releaseRepository: typeof releaseRepository;
  };
  expect(built.releaseRepository({})).toBe('example/published');
  expect(built.releaseRepository({ PUDDLE_REPO: 'example/host-override' })).toBe(
    'example/host-override',
  );
});

it('uses one fixed latest-stable endpoint and bounds its published metadata', async () => {
  const fetchFn = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.4.1',
          prerelease: false,
          assets: [
            { name: 'SHA256SUMS', browser_download_url: 'https://github.com/example/puddle/sums' },
          ],
        }),
      ),
  );
  expect(await latestGitHubRelease('example/puddle', { fetchFn })).toMatchObject({
    version: '0.4.1',
  });
  expect(fetchFn).toHaveBeenCalledWith(
    'https://api.github.com/repos/example/puddle/releases/latest',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await expect(
    latestGitHubRelease('example/puddle', {
      fetchFn: async () => new Response('x'.repeat(1024 * 1024 + 1)),
    }),
  ).rejects.toThrow('exceeds');
});

it.each([
  { tag_name: 'v0.4.1-beta' },
  { tag_name: 'v0.4.1', prerelease: true },
  { tag_name: 'v0.4.1', draft: true },
  { tag_name: '$(command)' },
  {
    tag_name: 'v0.4.1',
    assets: [{ name: 'file', browser_download_url: 'file:///private/archive' }],
  },
])('rejects unsafe or non-stable release metadata %#', async (value) => {
  await expect(
    latestGitHubRelease('example/puddle', {
      fetchFn: async () => new Response(JSON.stringify(value)),
    }),
  ).rejects.toThrow();
});

it('validates repository sources before fetching and never rounds version comparisons', async () => {
  const fetchFn = vi.fn();
  await expect(latestGitHubRelease('../private?token=secret', { fetchFn })).rejects.toThrow();
  expect(fetchFn).not.toHaveBeenCalled();
  expect(releaseRepository({ PUDDLE_REPO: 'example/puddle' })).toBe('example/puddle');
  expect(releaseRepository({ PUDDLE_REPO: 'https://private.example/repo' })).toBeUndefined();
  expect(isNewerVersion('9007199254740993.0.0', '9007199254740992.0.0')).toBe(true);
  expect(isNewerVersion('0.4.1-beta', '0.4.0')).toBe(false);
});
