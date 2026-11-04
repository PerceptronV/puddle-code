import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';

declare const __PUDDLER_VERSION__: string;

if (process.argv.includes('--version')) {
  const { major, minor } = RUNTIME_PROTOCOL_VERSION;
  process.stdout.write(`puddler ${__PUDDLER_VERSION__} (runtime protocol ${major}.${minor})\n`);
} else {
  await import('../runtime-provider-owner.js');
}
