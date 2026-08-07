import { createInterface } from 'node:readline';
import { CliError } from '../lib/types.js';

/**
 * y/N confirmation on the terminal, defaulting to NO — for `puddle remove`,
 * where the default must be the safe answer. `skip` is the --yes flag.
 * Without a TTY and without --yes the command refuses rather than assuming.
 */
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
