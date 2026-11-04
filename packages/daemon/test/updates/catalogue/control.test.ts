import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';
import { ipcPath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { startDaemon } from '../../../src/daemon.js';

it('composes lazy discovery through real host authority and reuses the cache after daemon replacement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-catalogue-control-'));
  const fetchFn = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.4.1',
          assets: [
            {
              name: `puddled-v0.4.1-${process.platform}-${process.arch}.tar.gz`,
              browser_download_url: 'https://example.test/archive',
            },
            { name: 'SHA256SUMS', browser_download_url: 'https://example.test/sums' },
          ],
        }),
      ),
  );
  vi.stubEnv('PUDDLE_REPO', 'example/puddle');
  vi.stubGlobal('fetch', fetchFn);
  try {
    for (let round = 0; round < 2; round++) {
      // An empty isolated host: no agents, shells, installed services or native stores are touched.
      const daemon = await startDaemon({ home, port: 0, adapters: [], version: '0.4.37' });
      const client = new HostControlClient(async () => connect(ipcPath(home, 'host')), false);
      const scoped = new HostControlClient(
        async () => connect(ipcPath(home, 'host')),
        false,
        undefined,
        '1111111111',
      );
      try {
        await client.establish();
        expect(await client.hostUpdate({ action: 'status' })).toEqual({
          ok: true,
          operation: null,
        });
        expect(fetchFn).toHaveBeenCalledTimes(round);
        await vi.waitFor(async () => {
          const reply = await client.hostUpdate({ action: 'status', include_catalogue: true });
          expect(reply).toMatchObject({
            ok: true,
            operation: null,
            catalogue: {
              daemon_version: '0.4.37',
              runtime_default: null,
              runtimes: { complete: true, versions: [] },
              releases: { state: 'ready', latest: { version: '0.4.1', host_asset: true } },
            },
          });
        });
        expect(fetchFn).toHaveBeenCalledOnce();
        await scoped.establish();
        await expect(
          scoped.hostUpdate({ action: 'status', include_catalogue: true }),
        ).rejects.toThrow('unavailable');
      } finally {
        client.close();
        scoped.close();
        await daemon.stop();
      }
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
