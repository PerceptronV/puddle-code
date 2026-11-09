import { randomUUID } from 'node:crypto';
import {
  realpathSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { huddleTemplateFiles, type HuddleDeliveryResult } from '@puddle/shared';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { workerJob, workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
it('publishes the editable report once, preserves conflicts and observes exact contents without writes', async () => {
  const f = huddleLedgerFixture();
  const root = realpathSync(f.home);
  const template = huddleTemplateFiles('write-report');
  const files = Object.fromEntries(
    Object.entries(template.files).map(([name, text]) => [`nodes/example/${name}`, text]),
  );
  const invocationId = randomUUID();
  const run = async (
    mode: 'deliver' | 'observe',
    path = 'reports/result.md',
    value = 'First report\n',
  ) => {
    const job = workerJob(template.files['run.ts'], {
      invocationId,
      component: template.component,
      files,
      inputs: { value },
      bindings: { worktree: root },
      parameters: { worktree: root, path, format: 'text' },
      readout: {
        mode,
        delivery: {
          format: 1,
          id: invocationId,
          invocationId,
          idempotencyKey: 'b'.repeat(64),
          event: f.event(),
          node: 'worker',
          inputs: { value },
        },
      },
    });
    let result: HuddleDeliveryResult | undefined;
    const handle = workers.start(job, {
      request: async (request) => {
        if (request.action.kind !== 'readout-result') throw new Error('Unexpected operation');
        result = request.action.result;
        return null;
      },
    });
    try {
      await handle.result;
    } catch (error) {
      if (!result || result.status === 'delivered') throw error;
    }
    await handle.exited;
    return result!;
  };
  try {
    const results = await Promise.all([run('deliver'), run('deliver')]);
    expect(results.map((result) => result.status).sort()).toEqual(['delivered', 'failed']);
    expect(readFileSync(join(root, 'reports/result.md'), 'utf8')).toBe('First report\n');
    expect(readdirSync(join(root, 'reports'))).toEqual(['result.md']);
    const delivered = results.find((result) => result.status === 'delivered')!;
    expect(delivered).toMatchObject({
      receipt: { worktree: root, path: 'reports/result.md', bytes: 13 },
    });
    expect(await run('observe')).toEqual(delivered);
    expect((await run('deliver', 'reports/result.md', 'Replacement')).status).toBe('failed');
    expect(readFileSync(join(root, 'reports/result.md'), 'utf8')).toBe('First report\n');
    writeFileSync(join(root, 'reports/result.md'), 'Human edit');
    expect((await run('observe')).status).toBe('unknown');
    expect(readFileSync(join(root, 'reports/result.md'), 'utf8')).toBe('Human edit');
    expect((await run('observe', 'missing/report.md')).status).toBe('unknown');
    expect(existsSync(join(root, 'missing'))).toBe(false);
    symlinkSync(join(root, 'reports'), join(root, 'linked'));
    expect((await run('deliver', 'linked/escape.md')).status).toBe('failed');
    expect(existsSync(join(root, 'reports/escape.md'))).toBe(false);
    expect((await run('deliver', '../escape.md')).status).toBe('failed');
    const expanded = await run('deliver', 'reports/{{huddleId}}/{{invocationId}}.md');
    expect(expanded).toMatchObject({
      status: 'delivered',
      receipt: { path: `reports/${f.identity.huddleId}/${invocationId}.md` },
    });
  } finally {
    f.cleanup();
  }
});
