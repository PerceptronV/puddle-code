import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../../electron-builder.cjs');
const builderRequire = createRequire(require.resolve('electron-builder'));
const { downloadElectronArtifactZip } = builderRequire('app-builder-lib/out/util/electronGet.js');

it('pins every shipped Electron archive to the installed package checksums', () => {
  expect(config.electronVersion).toBe(require('electron/package.json').version);
  expect(config.electronDownload.checksums).toEqual(require('electron/checksums.json'));
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64'])
    expect(
      config.electronDownload.checksums[`electron-v${config.electronVersion}-${target}.zip`],
    ).toMatch(/^[a-f0-9]{64}$/);
});

it('uses the real builder downloader without a checksum request and rejects corrupt bytes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-electron-checksums-'));
  const bytes = Buffer.from('fixture archive');
  const filename = `electron-v${config.electronVersion}-linux-x64.zip`;
  const requests: string[] = [];
  let corrupt = false;
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url!.endsWith('/' + filename)) res.end(corrupt ? 'corrupt' : bytes);
    else res.writeHead(504).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('ELECTRON_MIRROR', `http://127.0.0.1:${port}/`);
    const download = (cache: string) =>
      downloadElectronArtifactZip({
        artifactName: 'electron',
        arch: 'x64',
        platformName: 'linux',
        version: config.electronVersion,
        cacheDir: join(home, cache),
        electronDownload: {
          ...config.electronDownload,
          checksums: { [filename]: createHash('sha256').update(bytes).digest('hex') },
        },
      });
    expect(readFileSync(await download('valid'))).toEqual(bytes);
    corrupt = true;
    await expect(download('corrupt')).rejects.toThrow(/checksum/i);
    expect(requests).toEqual(Array(2).fill(`/v${config.electronVersion}/${filename}`));
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
