import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { repairSupervisorMarker } from '../../../src/host/supervision/repair-marker.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'marker-repair-'));
  homes.push(home);
  const marker = join(home, 'supervisor');
  writeFileSync(marker, 'systemd\n');
  chmodSync(marker, 0o664);
  return { home, marker };
}

it.each(['symlink', 'hardlink', 'owner', 'large', 'unknown', 'directory'] as const)(
  'refuses unsafe %s without probing or chmod',
  async (failure) => {
    const { home, marker } = fixture();
    const other = join(home, 'other');
    let uid = process.getuid!();
    if (failure === 'symlink') {
      renameSync(marker, other);
      symlinkSync(other, marker);
    }
    if (failure === 'hardlink') linkSync(marker, other);
    if (failure === 'owner') uid++;
    if (failure === 'large') writeFileSync(marker, 'x'.repeat(33));
    if (failure === 'unknown') writeFileSync(marker, 'nohup\n');
    if (failure === 'directory') chmodSync(home, 0o770);
    const corroborate = vi.fn(async () => {});
    await expect(repairSupervisorMarker(home, uid, corroborate, () => {})).rejects.toThrow();
    expect(corroborate).not.toHaveBeenCalled();
    expect(statSync(marker).mode & 0o777).toBe(0o664);
  },
);

it.each(['replaced', 'rewritten', 'linked', 'revoked'] as const)(
  'refuses a marker %s during service probes',
  async (failure) => {
    const { home, marker } = fixture();
    const corroborate = async () => {
      if (failure === 'replaced') {
        renameSync(marker, join(home, 'old'));
        writeFileSync(marker, 'systemd\n');
        chmodSync(marker, 0o664);
      }
      if (failure === 'rewritten') writeFileSync(marker, 'launchd\n');
      if (failure === 'linked') linkSync(marker, join(home, 'other'));
    };
    await expect(
      repairSupervisorMarker(home, process.getuid!(), corroborate, () => {
        if (failure === 'revoked') throw new Error('revoked');
      }),
    ).rejects.toThrow();
    expect(statSync(marker).mode & 0o777).toBe(0o664);
  },
);

it('only removes shared write bits and preserves contents', async () => {
  const { home, marker } = fixture();
  chmodSync(marker, 0o666);
  await repairSupervisorMarker(
    home,
    process.getuid!(),
    async (kind) => {
      expect(kind).toBe('systemd');
    },
    () => {},
  );
  expect(statSync(marker).mode & 0o777).toBe(0o644);
  expect(readFileSync(marker, 'utf8')).toBe('systemd\n');
});
