import { describe, expect, it } from 'vitest';
import { huddleComponentSchema } from '@puddle/shared';
import { workerJob, workerTestHarness } from '../../helpers/huddle/worker.js';
import { smokeHuddleWorker } from '../../../../../scripts/lib/huddle-smoke.mjs';

const workers = workerTestHarness();
const component = huddleComponentSchema.parse({
  ...workerJob('').component,
  dependencies: ['./helper.ts'],
});

describe('captured multi-file huddle scripts', () => {
  it('passes the archive smoke check with the same bundled entry layout', async () => {
    await smokeHuddleWorker(workers.stage, process.execPath);
  });
  it('loads TypeScript dependencies, HuddleNode and zod from the shipped worker modules', async () => {
    const job = workerJob(
      `
      import { HuddleNode } from 'puddlang/huddle';
      import { z } from 'zod';
      import { double } from './helper.ts';
      export default HuddleNode({ contract: './node.json', run({inputs}) {
        const value: number = z.number().parse(inputs.value);
        return { completed: double(value) };
      }});
    `,
      {
        component,
        files: { 'nodes/example/helper.ts': 'export const double = (n: number) => n * 2;' },
      },
    );
    const worker = workers.start(job);
    await expect(worker.result).resolves.toEqual({ completed: 42 });
    await worker.exited;
  });

  it.each(['./unlisted.ts', '../outside.ts', 'file:///tmp/not-captured.ts', 'some-package'])(
    'rejects import %s before executing the node body',
    async (specifier) => {
      const worker = workers.start(workerJob(`import '${specifier}'; export default {};`));
      await expect(worker.result).rejects.toThrow('outside the captured component');
    },
  );

  it('validates manifest agreement before spawning and wrapper agreement before invoking', async () => {
    const bad = workerJob('throw new Error("must not load");');
    bad.files['nodes/example/node.json'] = JSON.stringify({ ...bad.component, version: 2 });
    expect(() => workers.start(bad)).toThrow('manifest differs');
    const worker = workers.start(
      workerJob(`import { HuddleNode } from 'puddlang/huddle';
      export default HuddleNode({ contract: './other.json', run() { throw new Error('must not run'); }});`),
    );
    await expect(worker.result).rejects.toThrow('different contract');
  });

  it('enforces port validation and permits deliberate node built-in imports', async () => {
    const worker = workers.start(
      workerJob(`import { HuddleNode } from 'puddlang/huddle';
      import { basename } from 'node:path';
      export default HuddleNode({ contract: './node.json', run() { return { completed: basename('/a/b') }; }});`),
    );
    await expect(worker.result).rejects.toThrow('Invalid output');
  });
});
