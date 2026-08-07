import { createInterface } from 'node:readline';
import { CliError } from '../lib/types.js';

/**
 * y/N confirmation on the terminal, defaulting to NO — for `puddle remove`,
 * where the default must be the safe answer. `skip` is the --yes flag.
 * Without a TTY and without --yes the command refuses rather than assuming.
 */
/**
 * Free-text prompt with a default — for `install desktop` asking where the
 * AppImage should live. Unlike confirm(), a missing terminal is not an error:
 * the default is a safe answer, so non-interactive runs just take it.
 */
export async function ask(question: string, def: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [${def}] `, resolve),
    );
    return answer.trim() === '' ? def : answer.trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, opts: { skip?: boolean } = {}): Promise<boolean> {
  if (opts.skip === true) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      'bad_arguments',
      'refusing to confirm without a terminal',
      'pass --yes to proceed non-interactively',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${question} [y/N] `, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
