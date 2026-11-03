import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const DISPATCHER = 'puddle-hooks-v1.sh';

/** Replace only complete helper files; a concurrent hook must never read half a write. */
export function writeManagedHelper(file: string, source: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, source);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * V1 dispatch is deliberately stable across builds. Hooks already registered by
 * an older runtime can read a newer account configuration and still select the
 * owner's immutable helper and Node. Shell quoting preserves literal host paths.
 */
export function installHookDispatcher(directory: string): void {
  writeManagedHelper(
    join(directory, DISPATCHER),
    `#!/bin/sh
case "$1" in
  puddle-signal.mjs|puddle-turn.mjs|puddle-statusline.mjs) puddle_helper="$1"; shift ;;
  *) exit 1 ;;
esac
if [ -n "\${PUDDLE_AGENT_HELPER_DIR-}" ]; then
  [ -n "\${PUDDLE_AGENT_HELPER_NODE-}" ] || exit 1
  exec "$PUDDLE_AGENT_HELPER_NODE" "$PUDDLE_AGENT_HELPER_DIR/$puddle_helper" "$@"
fi
exec ${quote(process.execPath)} ${quote(directory)}/"$puddle_helper" "$@"
`,
  );
}

export function managedHookCommand(directory: string, file: string, ...args: string[]): string {
  return ['/bin/sh', join(directory, DISPATCHER), file, ...args].map(quote).join(' ');
}

/** Recognise only the old two-literal-argument managed command when migrating a status line. */
export function legacyHelperCommand(command: unknown, file: string): boolean {
  if (typeof command !== 'string') return false;
  const match = /^("(?:\\.|[^"\\])+") ("(?:\\.|[^"\\])+")$/.exec(command);
  if (!match) return false;
  try {
    const executable: unknown = JSON.parse(match[1]!);
    return (
      typeof executable === 'string' &&
      basename(executable) === 'node' &&
      JSON.parse(match[2]!) === file
    );
  } catch {
    return false;
  }
}
