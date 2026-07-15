#!/usr/bin/env node
import { parseArgs } from './cli/args.js';
import { run } from './cli/run.js';
import { CliError } from './lib/types.js';

try {
  const command = parseArgs(process.argv.slice(2));
  process.exit(await run(command));
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`puddle: ${err.message}\n`);
    if (err.hint !== undefined) process.stderr.write(`  hint: ${err.hint}\n`);
    process.exit(1);
  }
  throw err;
}
