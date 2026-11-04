import { PROTOCOL_VERSION } from '@puddle/shared';

declare const __PUDDLED_VERSION__: string;

if (process.argv.includes('--version')) {
  const { major, minor } = PROTOCOL_VERSION;
  process.stdout.write(`puddled ${__PUDDLED_VERSION__} (protocol ${major}.${minor})\n`);
} else {
  // The shared isolated daemon fixture uses fake adapters and port zero. Its
  // marker selects undefined runtime options, preserving production defaults.
  process.argv = [process.argv[0]!, process.argv[1]!, '--home', process.env.PUDDLE_HOME!];
  await import('../runtime-daemon.js');
}

export {};
