import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Pinned files must remain in one immutable installation generation. */
export function updateWorkerExecutables(home: string, release: string) {
  // eslint-disable-next-line no-control-regex -- Literal executable boundary.
  if (!isAbsolute(release) || /[\u0000-\u001f\u007f]/.test(release))
    throw new Error('Invalid worker executable path');
  const versions = realpathSync(join(home, 'bin', 'versions'));
  const root = realpathSync(release);
  if (dirname(root) !== versions) throw new Error('Update worker is outside installed releases');
  const file = (relative: string, access: number) => {
    const expected = join(root, relative);
    const path = realpathSync(expected);
    if (path !== expected || !statSync(path).isFile())
      throw new Error('Update worker file is not pinned to its release');
    accessSync(path, access);
    return path;
  };
  return {
    release_path: root,
    node_path: file('bin/node', constants.X_OK),
    entry_path: file('daemon/host-update.mjs', constants.R_OK),
    installer_path: file('daemon/install.sh', constants.R_OK),
  };
}
