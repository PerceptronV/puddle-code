import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Download-only substitution. Activation and installation execute the unchanged canonical script. */
export function fixtureStagingInstaller(
  release: string,
  archive: { version: string; path: string },
) {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const file = join(release, 'daemon/install.sh');
  renameSync(file, join(release, 'daemon/canonical-install.sh'));
  writeFileSync(
    file,
    `#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
stage=0
version=
previous=
for argument do
  [ "$argument" != --stage-only ] || stage=1
  [ "$previous" != --version ] || version=$argument
  previous=$argument
done
if [ "$stage" = 1 ]; then
  [ "$version" = ${quote(archive.version)} ] || exit 91
  exec /bin/sh "$root/canonical-install.sh" "$@" --tarball ${quote(archive.path)} --sums ${quote(archive.path + '.sha256')}
fi
exec /bin/sh "$root/canonical-install.sh" "$@"
`,
    { mode: 0o700 },
  );
}
