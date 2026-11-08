#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PROTOCOL_VERSION, runtimeReleaseCapabilities } from '@puddle/shared';
import { RuntimeHost } from './host.js';
import { HuddleOwner } from './huddle/owner.js';
import { readRuntimeJson, runtimeDirectory } from './ownership/storage.js';
import { join } from 'node:path';

declare const __PUDDLER_VERSION__: string | undefined;
const version =
  typeof __PUDDLER_VERSION__ !== 'undefined'
    ? __PUDDLER_VERSION__
    : (
        JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;

if (process.argv.length === 3 && process.argv[2] === '--runtime-capabilities') {
  console.log(JSON.stringify(runtimeReleaseCapabilities(version)));
} else if (process.argv.includes('--version')) {
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
  const launch = readRuntimeJson(join(runtimeDirectory(args[1]!, args[3]!), 'launch.json'));
  const huddle =
    typeof launch === 'object' && launch !== null && 'role' in launch && launch.role === 'huddle';
  if (typeof launch === 'object' && launch !== null && 'role' in launch && !huddle)
    throw new Error('Unsupported runtime role');
  const host = huddle
    ? await HuddleOwner.start(
        args[1]!,
        args[3]!,
        version,
        fileURLToPath(new URL('./huddle/runner.js', import.meta.url)),
      )
    : await RuntimeHost.start(args[1]!, args[3]!, version);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void host
        .stop()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          // Unknown child termination must retain the owner claim for explicit recovery.
          console.error(error instanceof Error ? error.message : 'Runtime stop failed');
        });
    });
  }
}
