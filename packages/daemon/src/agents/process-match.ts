import { posix } from 'node:path';

/** Match the executable or a direct Node/Bun entry point, never prompt arguments. */
export function matchesAgentProcess(
  command: string,
  binary: string,
  entryPoints: readonly string[],
): boolean {
  // ps does not preserve argv boundaries. Accept ordinary/quoted paths and
  // fail conservatively for ambiguous unquoted paths containing spaces.
  const words = command.match(/"[^"\n]*"|'[^'\n]*'|\S+/g) ?? [];
  const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/, '$2');
  const executable = posix.basename(unquote(words[0] ?? ''));
  if (executable === binary) return true;
  if (!['node', 'nodejs', 'bun'].includes(executable)) return false;
  const script = unquote(words[1] ?? '');
  if (!script || script.startsWith('-')) return false;
  return (
    posix.basename(script) === binary || entryPoints.some((entry) => script.endsWith(`/${entry}`))
  );
}
