import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HostReleaseChecks,
  HOST_RELEASE_CHECK_MS,
} from '../../../src/updates/catalogue/releases.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  const home = mkdtempSync(join(tmpdir(), 'puddle-release-checks-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const release = (version = '0.4.1', platform = 'linux') =>
    new Response(
      JSON.stringify({
        tag_name: `v${version}`,
        assets: [
          {
            name: `puddled-v${version}-${platform}-x64.tar.gz`,
            browser_download_url: 'https://example.test/archive',
          },
          { name: 'SHA256SUMS', browser_download_url: 'https://example.test/sums' },
        ],
      }),
    );
  const fetchFn = vi.fn(async () => release());
  const changed = vi.fn();
  const make = (repository: string | null = 'example/puddle') => {
    const checks = new HostReleaseChecks({
      home,
      changed,
      repository,
      fetchFn,
      platform: 'linux',
      arch: 'x64',
    });
    cleanup.push(() => checks.close());
    return checks;
  };
  return { home, release, fetchFn, changed, make };
}

it('coalesces windows into one lazy check and preserves the cadence across daemon replacement', async () => {
  const f = fixture();
  let resolve!: (value: Response) => void;
  f.fetchFn.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const checks = f.make();
  expect(f.fetchFn).not.toHaveBeenCalled();
  for (let i = 0; i < 20; i++) expect(checks.read().state).toBe('checking');
  const pending = checks.refresh();
  expect(checks.refresh()).toBe(pending);
  expect(f.fetchFn).toHaveBeenCalledOnce();
  resolve(f.release());
  await pending;
  expect(checks.read()).toMatchObject({
    state: 'ready',
    latest: { version: '0.4.1', host_asset: true },
  });
  checks.close();
  const replacement = f.make();
  expect(replacement.read().state).toBe('ready');
  expect(f.fetchFn).toHaveBeenCalledOnce();
  f.fetchFn.mockResolvedValueOnce(f.release('0.4.2'));
  await vi.advanceTimersByTimeAsync(HOST_RELEASE_CHECK_MS);
  expect(f.fetchFn).toHaveBeenCalledTimes(2);
  expect(replacement.read().latest?.version).toBe('0.4.2');
  expect(f.changed).toHaveBeenCalledTimes(4);
});

it('retains a timestamped last-known release on network failure and does not hammer retries', async () => {
  const f = fixture();
  const checks = f.make();
  await checks.refresh();
  const success = checks.read();
  f.fetchFn.mockResolvedValueOnce(new Response('offline', { status: 503 }));
  await vi.advanceTimersByTimeAsync(HOST_RELEASE_CHECK_MS);
  expect(checks.read()).toEqual({
    ...success,
    state: 'failed',
    checked_at: success.checked_at! + HOST_RELEASE_CHECK_MS,
  });
  await Promise.all(Array.from({ length: 20 }, () => checks.refresh()));
  expect(f.fetchFn).toHaveBeenCalledTimes(2);
  checks.close();
  expect(f.make().read()).toEqual(checks.read());
});

it('does not advertise platform support without both the host archive and checksums', async () => {
  const f = fixture();
  f.fetchFn.mockResolvedValueOnce(f.release('0.4.1', 'darwin'));
  const checks = f.make();
  await checks.refresh();
  expect(checks.read().latest).toEqual({ version: '0.4.1', host_asset: false });
});

it('does not reuse another repository cache or perform lookups for an unconfigured build', async () => {
  const f = fixture();
  const original = f.make();
  await original.refresh();
  original.close();
  const unconfigured = f.make(null);
  expect(unconfigured.read()).toMatchObject({
    state: 'unconfigured',
    latest: null,
    repository: null,
  });
  await unconfigured.refresh();
  expect(f.fetchFn).toHaveBeenCalledOnce();
  const replacement = f.make('example/other');
  expect(replacement.read()).toMatchObject({ state: 'checking', latest: null });
  await replacement.refresh();
  expect(f.fetchFn).toHaveBeenLastCalledWith(
    'https://api.github.com/repos/example/other/releases/latest',
    expect.any(Object),
  );
});

it('aborts shutdown without publishing or persisting a late successful response', async () => {
  const f = fixture();
  let resolve!: (value: Response) => void;
  f.fetchFn.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const checks = f.make();
  const pending = checks.refresh();
  const before = readFileSync(join(f.home, 'updates/release-check.json'), 'utf8');
  checks.close();
  resolve(f.release());
  await pending;
  expect(readFileSync(join(f.home, 'updates/release-check.json'), 'utf8')).toBe(before);
  expect(f.changed).toHaveBeenCalledOnce();
});

it('keeps in-memory discovery usable when cache persistence fails', async () => {
  const f = fixture();
  writeFileSync(join(f.home, 'updates'), 'not a directory');
  const checks = f.make();
  await checks.refresh();
  expect(checks.read()).toMatchObject({ state: 'ready', latest: { version: '0.4.1' } });
});
