import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Lose one successful runtime-selection reply without replacing installer behaviour. */
export function loseRuntimeSelectionReply(release: string): void {
  const directory = join(release, 'daemon');
  copyFileSync(join(directory, 'install.sh'), join(directory, 'install-canonical.sh'));
  writeFileSync(
    join(directory, 'install.sh'),
    `#!/bin/sh
set -eu
directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
/bin/sh "$directory/install-canonical.sh" "$@"
component=
select_only=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --component) shift; component=$1 ;;
    --select-only) select_only=yes ;;
  esac
  shift
done
if [ "$component" = runtime ] && [ "$select_only" = yes ]; then
  printf 'selected\\n' >> "$PUDDLE_HOME/test-selection-dispatches"
  if [ ! -f "$PUDDLE_HOME/test-selection-reply-lost" ]; then
    : > "$PUDDLE_HOME/test-selection-reply-lost"
    exit 77
  fi
fi
`,
    { mode: 0o700 },
  );
}
