import type { Logger } from '../lib/types.js';

/** The bin's logger: status to stderr so stdout stays pipeable. */
export function terminalLogger(): Logger {
  return {
    info(message) {
      process.stderr.write(`${message}\n`);
    },
    warn(message) {
      process.stderr.write(`puddle: ${message}\n`);
    },
  };
}
