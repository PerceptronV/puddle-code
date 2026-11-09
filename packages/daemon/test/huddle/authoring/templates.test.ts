import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { build } from 'esbuild';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { huddleAuthoringFiles, coreHuddleComponents, huddleEventSchema } from '@puddle/shared';
import { authoringComponents } from '../../../../shared/src/huddle/authoring/templates/components.js';
import { huddleSdkTypes } from '../../../../shared/src/huddle/authoring/sdk.js';
import { huddleAuthoringTypes } from '../../../../../scripts/lib/huddle/types.mjs';
import { captureHuddleDefinition } from '../../../src/huddle/definitions/capture.js';
import { executeHuddleNode } from '../../../src/puddlang/huddle/execute.js';
import { openHuddleTrigger } from '../../../src/puddlang/huddle/execute-trigger.js';
import { executeHuddleReadout } from '../../../src/puddlang/huddle/execute-readout.js';
import type { HuddleNodeModule } from '../../../src/puddlang/huddle/node.js';
import type {
  HuddleTriggerAdapter,
  HuddleReadoutAdapter,
} from '../../../src/puddlang/huddle/context.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const files = huddleAuthoringFiles();
let home: string;
const adapters: Record<string, unknown> = {};
beforeAll(async () => {
  home = mkdtempSync(join(root, 'packages/daemon/node_modules/.huddle-authoring-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  for (const [name, entry] of [
    ['transform', 'run'],
    ['feed', 'trigger'],
    ['report', 'readout'],
  ]) {
    const bundle = await build({
      entryPoints: [join(home, `templates/${name}/${entry}.ts`)],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      alias: { '@puddle/shared': join(root, 'packages/shared/src/index.ts') },
      plugins: [
        {
          name: 'pinned-huddle-sdk',
          setup(build) {
            build.onResolve({ filter: /^puddlang\/huddle$/ }, () => ({
              path: 'sdk',
              namespace: 'huddle',
            }));
            build.onLoad({ filter: /.*/, namespace: 'huddle' }, () => ({
              contents: ['node', 'trigger', 'readout']
                .map(
                  (file) =>
                    `export * from ${JSON.stringify(join(root, `packages/daemon/src/puddlang/huddle/${file}.ts`))};`,
                )
                .join('\n'),
              resolveDir: root,
            }));
          },
        },
      ],
    });
    adapters[name!] = (
      await import(
        'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0]!.text).toString('base64')
      )
    ).default;
  }
  return () => rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('generates current standalone types and type-checks all template scripts without runtime stubs', async () => {
  expect(await huddleAuthoringTypes(root)).toBe(huddleSdkTypes);
  const roots = Object.keys(files)
    .filter((path) => path.endsWith('.ts'))
    .map((path) => join(home, path));
  const parity = join(home, 'sdk-parity.ts');
  writeFileSync(
    parity,
    `
import type * as Kit from 'puddlang/huddle';
import type * as Actual from ${JSON.stringify(join(root, 'packages/daemon/src/puddlang/huddle/context.ts'))};
import type { PuddlangAgent } from ${JSON.stringify(join(root, 'packages/daemon/src/puddlang/client.ts'))};
type Assert<T extends true> = T;
type Equivalent<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Trigger = Assert<Equivalent<Kit.HuddleTriggerAdapter, Actual.HuddleTriggerAdapter>>;
type Readout = Assert<Equivalent<Kit.HuddleReadoutAdapter, Actual.HuddleReadoutAdapter>>;
type Agent = Assert<Equivalent<Kit.PuddlangAgent, Pick<PuddlangAgent, keyof PuddlangAgent>>>;
type Context = Assert<Equivalent<Omit<Kit.HuddleNodeContext, 'puddlang'>, Omit<Actual.HuddleNodeContext, 'puddlang'>>>;
`,
  );
  roots.push(parity);
  const program = ts.createProgram(roots, {
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ['node'],
    typeRoots: [join(root, 'packages/daemon/node_modules/@types')],
    allowImportingTsExtensions: true,
  });
  const errors = ts.getPreEmitDiagnostics(program);
  const messages = errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  expect(messages, messages.join('\n')).toEqual([]);
});

it.each(['manual', 'feed-report'])(
  'captures the %s example through production source validation without evaluating adapters',
  async (name) => {
    const id = '0'.repeat(32);
    const directory = join(home, '.puddle/huddle', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'huddle.json'), files[`examples/${name}.json`]!);
    for (const [path, text] of Object.entries(files))
      if (path.startsWith('templates/')) {
        const target = join(directory, path.replace('templates/', 'nodes/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
    const snapshot = await captureHuddleDefinition(home, id, coreHuddleComponents);
    expect(snapshot.diagnostics).toEqual([]);
    expect(Object.keys(snapshot.files)).toContain('nodes/transform/run.ts');
    if (name === 'feed-report') expect(Object.keys(snapshot.files)).toContain('nodes/feed/http.ts');
  },
);

it('runs the transform through the immutable runtime contract boundary', async () => {
  const fixture = JSON.parse(files['fixtures/transform.json']!);
  expect(
    await executeHuddleNode(adapters.transform as HuddleNodeModule, authoringComponents.transform, {
      inputs: fixture.inputs,
      parameters: {},
      bindings: {},
      signal: new AbortController().signal,
      puddlang: { attach: vi.fn(), spawn: vi.fn() },
      emit: vi.fn(),
    }),
  ).toEqual(fixture.outputs);
});

function triggerContext() {
  return {
    parameters: { url: 'https://fixture.invalid/feed', intervalMs: 15000 },
    bindings: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    checkpoint: vi.fn(async () => {}),
    health: vi.fn(async () => {}),
    emit: vi.fn(async () => ({ sequence: 1, duplicate: false })),
  };
}
it('waits for event acknowledgement before checkpointing, then closes its timer', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response(files['fixtures/feed-page.json']));
  vi.stubGlobal('fetch', fetch);
  const context = triggerContext();
  let release!: () => void;
  context.emit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ sequence: 1, duplicate: false });
      }),
  );
  const opening = openHuddleTrigger(
    adapters.feed as HuddleTriggerAdapter,
    authoringComponents.feed,
    context,
    'previous',
  );
  await vi.waitFor(() => expect(context.emit).toHaveBeenCalledOnce());
  expect(context.checkpoint).not.toHaveBeenCalled();
  expect(String(fetch.mock.calls[0]![0])).toContain('after=previous');
  release();
  const subscription = await opening;
  expect(context.checkpoint).toHaveBeenCalledExactlyOnceWith('page-1');
  await subscription.close();
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetch).toHaveBeenCalledOnce();
});
it('reports missing history and admission failure without advancing the cursor', async () => {
  const fetch = vi.fn(async () => new Response(files['fixtures/feed-gap.json']));
  vi.stubGlobal('fetch', fetch);
  const context = triggerContext();
  const subscription = await openHuddleTrigger(
    adapters.feed as HuddleTriggerAdapter,
    authoringComponents.feed,
    context,
    'expired',
  );
  expect(context.health).toHaveBeenCalledExactlyOnceWith({
    state: 'gap',
    message: 'Feed history expired',
    after: 'expired',
  });
  expect(context.emit).not.toHaveBeenCalled();
  expect(context.checkpoint).not.toHaveBeenCalled();
  await subscription.close();
  fetch.mockImplementation(async () => new Response(files['fixtures/feed-page.json']));
  context.emit.mockRejectedValue(new Error('Admission unavailable'));
  const failed = await openHuddleTrigger(
    adapters.feed as HuddleTriggerAdapter,
    authoringComponents.feed,
    context,
    null,
  );
  expect(context.checkpoint).not.toHaveBeenCalled();
  expect(context.health).toHaveBeenLastCalledWith({
    state: 'degraded',
    message: 'Error: Admission unavailable',
  });
  await failed.close();
});

it('cancels in-flight polling and settles close without another poll', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response(files['fixtures/feed-page.json']));
  let requestSignal: AbortSignal | null | undefined;
  fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        requestSignal = options?.signal;
        requestSignal!.addEventListener('abort', () => reject(new Error('Cancelled')), {
          once: true,
        });
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const subscription = await openHuddleTrigger(
    adapters.feed as HuddleTriggerAdapter,
    authoringComponents.feed,
    triggerContext(),
    null,
  );
  await vi.advanceTimersByTimeAsync(15000);
  expect(fetch).toHaveBeenCalledTimes(2);
  await subscription.close();
  expect(requestSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

function delivery() {
  const id = randomUUID();
  return {
    format: 1 as const,
    id,
    invocationId: id,
    idempotencyKey: 'a'.repeat(64),
    node: 'report',
    inputs: { value: 'fixture' },
    event: huddleEventSchema.parse({
      format: 1,
      id,
      source: { node: 'feed', component: 'project.trigger.feed', version: 1 },
      port: 'event',
      observedAt: new Date().toISOString(),
      scope: {
        hostId: 'fixture',
        profileId: '0123456789',
        projectId: 'abcdef1234',
        huddleId: '0'.repeat(32),
        sessionId: randomUUID(),
        runtimeId: randomUUID(),
      },
      revision: 'a'.repeat(64),
      executionId: randomUUID(),
      data: 'fixture',
    }),
  };
}
it('confirms only valid delivery receipts and leaves errors/oversized replies unknown without retry', async () => {
  const fetch = vi.fn(async () => new Response(files['fixtures/report-confirmation.json']));
  vi.stubGlobal('fetch', fetch);
  const envelope = delivery();
  const run = () =>
    executeHuddleReadout(
      adapters.report as HuddleReadoutAdapter,
      authoringComponents.report,
      {
        parameters: { endpoint: 'https://fixture.invalid/report' },
        bindings: {},
        log: vi.fn(),
        signal: new AbortController().signal,
      },
      envelope,
      'deliver',
    );
  expect(await run()).toMatchObject({
    status: 'delivered',
    receipt: { id: 'receipt-1' },
    outputs: { completed: { id: 'receipt-1' } },
  });
  expect(fetch.mock.calls[0]![1]).toMatchObject({
    headers: { 'idempotency-key': envelope.idempotencyKey },
  });
  for (const response of [
    new Response('{}', { status: 500 }),
    new Response('{}'),
    new Response('x'.repeat(256 * 1024 + 1)),
  ]) {
    fetch.mockResolvedValueOnce(response);
    expect(await run()).toMatchObject({ status: 'unknown' });
  }
  fetch.mockRejectedValueOnce(new Error('Lost reply'));
  expect(await run()).toMatchObject({ status: 'unknown' });
  expect(fetch).toHaveBeenCalledTimes(5);
});
