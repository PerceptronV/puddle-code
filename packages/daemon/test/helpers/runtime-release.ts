import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Metadata-only release for resolution/dispatch tests; never starts a process. */
export function runtimeRelease(home: string, build = '1.2.3', protocol = '1.0') {
  const name = `${build}~${randomUUID()}`;
  const release = join(home, 'bin', 'versions', name);
  mkdirSync(join(release, 'bin'), { recursive: true });
  mkdirSync(join(release, 'daemon'));
  writeFileSync(join(release, 'VERSION'), `${build}\n`);
  writeFileSync(join(release, 'RUNTIME_PROTOCOL'), `${protocol}\n`);
  writeFileSync(join(release, 'bin', 'node'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  writeFileSync(join(release, 'daemon', 'puddler.mjs'), '// metadata fixture\n');
  const select = () => {
    const temporary = join(home, 'bin', `select-${randomUUID()}`);
    symlinkSync(`versions/${name}`, temporary);
    renameSync(temporary, join(home, 'bin', 'runtime-current'));
  };
  return { release, select };
}
