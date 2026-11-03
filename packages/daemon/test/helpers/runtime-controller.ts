import { join } from 'node:path';
import { runtimeLaunchSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { RuntimeClient } from '../../src/runtime/client.js';
import {
  acquireRuntimeController,
  readRuntimeJson,
  runtimeDirectory,
} from '../../src/runtime/storage.js';

// Isolated process fixture: never starts puddled or loads provider accounts.
const home = process.argv[2]!;
const id = process.argv[3]!;
const controller = acquireRuntimeController(home);
const launch = runtimeLaunchSchema.parse(
  readRuntimeJson(join(runtimeDirectory(home, id), 'launch.json')),
);
const client = await RuntimeClient.open(home, launch, controller.record);
process.send?.({ t: 'ready', controller: controller.record, state: client.state });
atomicPrivateJson(join(home, 'controller-ready.json'), {
  controller: controller.record,
  pid: process.pid,
});
process.on('disconnect', () => {
  client.close();
  controller.release();
});
