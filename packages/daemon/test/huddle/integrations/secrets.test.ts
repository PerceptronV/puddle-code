import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { huddleComponentSchema, type HuddleWorkerAction } from '@puddle/shared';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { huddleSecretResolver } from '../../../src/huddle/integrations/secrets.js';
import { workerJob, workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
const component = huddleComponentSchema.parse({
  format: 1,
  id: 'fixture.script.secret',
  version: 1,
  category: 'script',
  title: 'Integration',
  entry: './run.ts',
  inputs: { value: { schema: { type: 'number' } } },
  outputs: { completed: { schema: { type: 'number' } } },
  parameters: { token: { editor: 'secret', schema: { type: 'string' } } },
});
const scope = {
  profileId: 'profile',
  projectId: 'project',
  huddleId: 'a'.repeat(32),
  worktree: '/project',
};

it('keeps exact private grants separate from source and rereads rotations before worker startup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'huddle-secrets-'));
  const file = join(home, 'huddle-integrations.json');
  const write = (value: string) =>
    writeFileSync(
      file,
      JSON.stringify({ format: 1, grants: [{ ...scope, values: { service_token: value } }] }),
      { mode: 0o600 },
    );
  const resolve = huddleSecretResolver(home, scope);
  const job = workerJob(
    `import { HuddleNode } from 'puddlang/huddle';
export default HuddleNode({contract:'./node.json', async run(ctx) {
  if (ctx.parameters.token !== 'service_token' || !Object.isFrozen(ctx.secrets)) throw new Error('Invalid context');
  console.log(ctx.secrets.token.slice(0, 3));
  console.error(ctx.secrets.token.slice(3));
  return {completed: ctx.secrets.token.length};
}});`,
    { component, parameters: { token: 'service_token' } },
  );
  const logs: string[] = [];
  try {
    write('private-first-value');
    const first = workers.start(job, { secrets: resolve, log: (_, text) => logs.push(text) });
    await expect(first.result).resolves.toEqual({ completed: 19 });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((line) => line === '[Integration worker output redacted]\n')).toBe(true);
    expect(JSON.stringify(job)).not.toContain('private-first-value');
    write('rotated-value');
    await expect(workers.start(job, { secrets: resolve }).result).resolves.toEqual({
      completed: 13,
    });
    const failure = workerJob(
      `import { HuddleNode } from 'puddlang/huddle';
export default HuddleNode({contract:'./node.json', async run(ctx) { throw new Error(ctx.secrets.token); }});`,
      { component, parameters: job.parameters },
    );
    await expect(workers.start(failure, { secrets: resolve }).result).rejects.toThrow(
      'private diagnostics redacted',
    );
    expect(() => workers.start(job)).toThrow('resolution is unavailable');
    expect(() =>
      huddleSecretResolver(home, { ...scope, worktree: '/other' })(component, job.parameters),
    ).toThrow('Integration secrets unavailable');
    expect(() => resolve(component, { token: 'missing' })).toThrow(
      'Integration secrets unavailable',
    );
    chmodSync(file, 0o644);
    expect(() => resolve(component, job.parameters)).toThrow('Integration secrets unavailable');
    rmSync(file);
    writeFileSync(join(home, 'outside'), 'private-file-value');
    symlinkSync(join(home, 'outside'), file);
    expect(() => resolve(component, job.parameters)).toThrow('Integration secrets unavailable');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('redacts readout refusal and trigger health before their owner records them', async () => {
  const fixture = huddleLedgerFixture();
  const seen: HuddleWorkerAction[] = [];
  const secrets = () => ({ token: 'private-integration-token' });
  const request = async (message: { action: HuddleWorkerAction }) => {
    seen.push(message.action);
    return null;
  };
  try {
    const invocationId = randomUUID();
    const readout = workerJob(
      `import { HuddleReadout } from 'puddlang/huddle';
export default HuddleReadout({contract:'./node.json', async deliver(ctx) {
  return {status:'failed',message:ctx.secrets.token};
}});`,
      {
        component: huddleComponentSchema.parse({
          ...component,
          category: 'readout',
          readout: { idempotent: false, reconciliation: 'none', cancellation: 'none' },
        }),
        parameters: { token: 'service_token' },
        invocationId,
        readout: {
          mode: 'deliver',
          delivery: {
            format: 1,
            id: invocationId,
            invocationId,
            idempotencyKey: 'a'.repeat(64),
            event: fixture.event(),
            node: 'worker',
            inputs: { value: 21 },
          },
        },
      },
    );
    await expect(workers.start(readout, { secrets, request }).result).rejects.toThrow(
      'private diagnostics redacted',
    );
    expect(seen).toEqual([
      {
        kind: 'readout-result',
        result: {
          status: 'failed',
          message: 'Integration delivery did not complete (private diagnostics redacted)',
        },
      },
    ]);
    const {
      invocationId: _invocation,
      inputs: _inputs,
      readout: _readout,
      ...source
    } = workerJob(
      `import { HuddleTrigger } from 'puddlang/huddle';
export default HuddleTrigger({contract:'./node.json', async open(ctx) {
  await ctx.health({state:'degraded',message:ctx.secrets.token});
  return {async close(){}};
}});`,
      {
        component: huddleComponentSchema.parse({
          ...component,
          category: 'trigger',
          inputs: {},
          trigger: { resume: 'continue' },
        }),
        parameters: { token: 'service_token' },
      },
    );
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const trigger = workers.start(
      { ...source, subscriptionId: randomUUID(), cursor: null },
      { secrets, request, opened },
    );
    await Promise.race([ready, trigger.result]);
    expect(seen[1]).toEqual({
      kind: 'trigger-health',
      health: { state: 'degraded', message: 'Integration health diagnostic redacted' },
    });
    trigger.cancel();
    await trigger.result.catch(() => {});
    await trigger.exited;
    expect(JSON.stringify(seen)).not.toContain('private-integration-token');
  } finally {
    fixture.cleanup();
  }
});
