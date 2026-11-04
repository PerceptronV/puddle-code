import { execFile } from 'node:child_process';
import { constants, openSync, readSync, closeSync } from 'node:fs';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kernel-issued boot identity only. Timestamps and process ids cannot prove a reboot. */
export async function readHostBootIdentity(
  options: {
    platform?: NodeJS.Platform;
    linux?: () => string;
    darwin?: () => Promise<string>;
  } = {},
): Promise<string | null> {
  try {
    const platform = options.platform ?? process.platform;
    let value: string;
    if (platform === 'linux') {
      value = (
        options.linux ??
        (() => {
          const fd = openSync(
            '/proc/sys/kernel/random/boot_id',
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const bytes = Buffer.alloc(128);
            const length = readSync(fd, bytes, 0, bytes.length, null);
            if (length === bytes.length) throw new Error('Kernel boot identity exceeds its limit');
            return bytes.subarray(0, length).toString('ascii');
          } finally {
            closeSync(fd);
          }
        })
      )();
    } else if (platform === 'darwin') {
      value = await (
        options.darwin ??
        (async () => {
          const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
            timeout: 3000,
            maxBuffer: 128,
            encoding: 'utf8',
          });
          if (result.stderr) throw new Error('Kernel boot identity inspection failed');
          return result.stdout;
        })
      )();
    } else return null;
    if (
      value.length > 128 ||
      !uuid.test(value.trim()) ||
      /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value.trim())
    )
      return null;
    return value.trim().toLowerCase();
  } catch {
    // Unknown remains unknown; callers must never substitute time or a cached id.
    return null;
  }
}
