import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { puddlangEntryPoints } from '../../../../../scripts/lib/puddlang-build.mjs';
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  huddleComponentSchema,
  huddleWorkerJobSchema,
  type HuddleWorkerJob,
  type HuddleTriggerWorkerJob,
} from '@puddle/shared';
import {
  startHuddleWorker,
  type HuddleWorkerHandle,
  type HuddleWorkerOptions,
} from '../../../src/runtime/huddle/workers/process.js';

export function workerJob(source: string, overrides: Partial<HuddleWorkerJob> = {}) {
  const component = huddleComponentSchema.parse(
    overrides.component ?? {
      format: 1,
      id: 'fixture.script.worker',
      version: 1,
      category: 'script',
      title: 'Worker',
      entry: './run.ts',
      inputs: { value: { schema: { type: 'number' } } },
      outputs: {
        completed: { schema: { type: 'number' } },
        turn: { schema: { type: 'number' }, emission: 'event', required: false },
      },
    },
  );
  return huddleWorkerJobSchema.parse({
    invocationId: randomUUID(),
    revision: 'a'.repeat(64),
    node: 'worker',
    manifest: 'nodes/example/node.json',
    component,
    inputs: { value: 21 },
    parameters: {},
    bindings: {},
    ...overrides,
    files: {
      'nodes/example/node.json': JSON.stringify(component),
      'nodes/example/run.ts': source,
      ...overrides.files,
    },
  });
}

export function workerTestHarness() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  let compiled: string;
  const handles: HuddleWorkerHandle[] = [];
  beforeAll(async () => {
    compiled = mkdtempSync(join(root, 'node_modules/.huddle-worker-test-'));
    await build({
      entryPoints: puddlangEntryPoints(join(root, '../..')),
      outdir: join(compiled, 'daemon'),
      bundle: true,
      splitting: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: { '@puddle/shared': join(root, '../shared/src/index.ts') },
    });
  });
  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.cancel('Fixture cleanup');
      await handle.exited;
      await handle.result.catch(() => {});
    }
  });
  afterAll(() => {
    if (compiled) rmSync(compiled, { recursive: true, force: true });
  });
  return {
    get stage() {
      return compiled;
    },
    start(
      job: HuddleWorkerJob | HuddleTriggerWorkerJob,
      options: Partial<HuddleWorkerOptions> = {},
    ) {
      const handle = startHuddleWorker(job, {
        nodePath: process.execPath,
        entryPath: join(compiled, 'daemon/huddle/runner.js'),
        cwd: compiled,
        timeoutMs: 5000,
        request: async () => {
          throw new Error('No host operations in this fixture');
        },
        ...options,
      });
      handles.push(handle);
      void handle.result.catch(() => {});
      return handle;
    },
  };
}
