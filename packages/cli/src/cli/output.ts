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

/** A detached cockpit's stderr is a log file: stamp lines so outages can be dated. */
export function timestampedLogger(): Logger {
  const line = (message: string) => `${new Date().toISOString()} ${message}\n`;
  return {
    info(message) {
      process.stderr.write(line(message));
    },
    warn(message) {
      process.stderr.write(line(`puddle: ${message}`));
    },
  };
}
