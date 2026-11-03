#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PROTOCOL_VERSION } from '@puddle/shared';
import { RuntimeHost } from './host.js';

declare const __PUDDLER_VERSION__: string | undefined;
const version =
  typeof __PUDDLER_VERSION__ !== 'undefined'
    ? __PUDDLER_VERSION__
    : (
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;

if (process.argv.includes('--version')) {
  console.log(
    `puddler ${version} (runtime protocol ${RUNTIME_PROTOCOL_VERSION.major}.${RUNTIME_PROTOCOL_VERSION.minor})`,
  );
} else {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--home' || args[2] !== '--runtime') {
    throw new Error(
      `Usage: ${fileURLToPath(import.meta.url)} --home <private-home> --runtime <runtime-id>`,
    );
  }
  const host = await RuntimeHost.start(args[1]!, args[3]!, version);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void host.stop().then(() => process.exit(0));
    });
  }
}
