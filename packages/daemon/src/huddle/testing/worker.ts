import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  huddleWorkerJobSchema,
  huddleTriggerWorkerJobSchema,
  huddleJsonSchema,
  type HuddleJson,
} from '@puddle/shared';
import { HuddleNode, HuddleTrigger, HuddleReadout } from './sdk.js';
import { setFixtureClient } from './api.js';
import { installWorkerImports } from '../../runtime/huddle/workers/source.js';
import { executeHuddleNode } from '../../puddlang/huddle/execute.js';
import { openHuddleTrigger } from '../../puddlang/huddle/execute-trigger.js';
import { executeHuddleReadout } from '../../puddlang/huddle/execute-readout.js';
import { huddleExecutableCaseSchema } from './fixture.js';
import { fixtureMocks } from './mocks.js';

async function run() {
  // Only the parent supplies stdin, containing one bounded captured component and case.
  const raw = JSON.parse(readFileSync(0, 'utf8'));
  const fixture = huddleExecutableCaseSchema.parse(raw.fixture);
  const job = raw.job?.subscriptionId
    ? huddleTriggerWorkerJobSchema.parse(raw.job)
    : huddleWorkerJobSchema.parse(raw.job);
  const mocks = fixtureMocks(fixture);
  globalThis.fetch = mocks.fetch;
  setFixtureClient(mocks.api);
  const log = (...values: unknown[]) => process.stderr.write(values.map(String).join(' ') + '\n');
  console.log = log;
  console.info = log;
  console.warn = log;
  const abort = new AbortController();
  const timer =
    fixture.abortAfterMs === undefined
      ? undefined
      : setTimeout(() => abort.abort(new Error('Fixture cancellation')), fixture.abortAfterMs);
  const emissions: HuddleJson[] = [],
    health: HuddleJson[] = [],
    checkpoints: HuddleJson[] = [];
  const collect = (items: HuddleJson[], value: unknown) => {
    if (items.length >= 64) throw new Error('Fixture observation limit exceeded');
    items.push(structuredClone(huddleJsonSchema.parse(value)));
  };
  const context = {
    parameters: job.parameters,
    bindings: job.bindings,
    secrets: Object.freeze(fixture.secrets),
    signal: abort.signal,
    log,
  };
  let outputs: unknown, result: unknown, failure: unknown;
  try {
    const imports = installWorkerImports(job, new URL('./sdk.mjs', import.meta.url).href);
    const module = await import(imports.entryUrl);
    if ('subscriptionId' in job) {
      const adapter = HuddleTrigger(module.default);
      imports.checkContract(adapter.contract);
      const subscription = await openHuddleTrigger(
        adapter,
        job.component,
        {
          ...context,
          emit: async (value) => {
            collect(emissions, value);
            return { sequence: emissions.length, duplicate: false };
          },
          health: async (value) => {
            collect(health, value);
          },
          checkpoint: async (value) => {
            collect(checkpoints, value);
          },
        },
        fixture.cursor,
      );
      try {
        if (fixture.observeMs) await delay(fixture.observeMs, undefined, { signal: abort.signal });
      } finally {
        await subscription.close();
      }
    } else if (job.readout) {
      const adapter = HuddleReadout(module.default);
      imports.checkContract(adapter.contract);
      result = await executeHuddleReadout(
        adapter,
        job.component,
        context,
        job.readout.delivery,
        job.readout.mode,
      );
    } else {
      const adapter = HuddleNode(module.default);
      imports.checkContract(adapter.contract);
      outputs = await executeHuddleNode(adapter, job.component, {
        ...context,
        inputs: job.inputs,
        puddlang: mocks.api,
        emit: async (port, value) => {
          collect(emissions, { port, value });
        },
      });
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }
  mocks.verify();
  if (fixture.expect.errorIncludes !== undefined) {
    assert.ok(failure, 'Expected component execution to fail');
    assert.ok(
      String(failure).includes(fixture.expect.errorIncludes),
      `Unexpected failure: ${String(failure)}`,
    );
  } else if (failure) throw failure;
  for (const [key, value] of Object.entries({ outputs, result, emissions, health, checkpoints }))
    if (Object.hasOwn(fixture.expect, key))
      assert.deepEqual(
        value,
        fixture.expect[key as keyof typeof fixture.expect],
        `Fixture ${key} differ`,
      );
}

void run().then(
  () => {
    process.stdout.write(JSON.stringify({ passed: true }) + '\n', () => process.exit(0));
  },
  (error) => {
    process.stdout.write(
      JSON.stringify({ passed: false, error: String(error).slice(0, 8192) }) + '\n',
      () => process.exit(1),
    );
  },
);
