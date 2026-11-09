import { Socket } from 'node:net';
import {
  huddleWorkerInputSchema,
  type HuddleWorkerJob,
  type HuddleTriggerWorkerJob,
} from '@puddle/shared';
import { readRuntimeFrames, writeRuntimeFrame } from '../../transport/framing.js';
import { executeHuddleNode } from '../../../puddlang/huddle/execute.js';
import { HuddleNode } from '../../../puddlang/huddle/node.js';
import { HuddleReadout } from '../../../puddlang/huddle/readout.js';
import { executeHuddleReadout } from '../../../puddlang/huddle/execute-readout.js';
import { HuddleTrigger } from '../../../puddlang/huddle/trigger.js';
import { openHuddleTrigger } from '../../../puddlang/huddle/execute-trigger.js';
import { HuddleWorkerCalls } from './calls.js';
import { installWorkerImports } from './source.js';
import './sdk.js';

const socket = new Socket({ fd: 3, readable: true, writable: true });
const abort = new AbortController();
let started = false;
let secrets: Readonly<Record<string, string>> = Object.freeze({});
let finished = false;
let cancellation: 'none' | 'signal' = 'none';
const calls = new HuddleWorkerCalls((message) => {
  if (!writeRuntimeFrame(socket, message)) throw new Error('Huddle worker transport closed');
});
function disconnected(error: Error) {
  if (abort.signal.aborted) return;
  abort.abort(error);
  calls.close(error);
  if (cancellation === 'signal' && !finished) {
    // Best-effort cleanup only, never proof that the destination did not receive a delivery.
    setTimeout(() => process.exit(1), 250);
    return;
  }
  process.exit(1);
}
socket.on('error', disconnected);
socket.on('close', () => {
  if (!finished) disconnected(new Error('Huddle owner disconnected'));
});
process.on('SIGTERM', () => disconnected(new Error('Huddle worker terminated')));
readRuntimeFrames(
  socket,
  (raw) => {
    const message = huddleWorkerInputSchema.parse(raw);
    if (message.type === 'cancel') return disconnected(new Error(message.reason));
    if (message.type !== 'start' && message.type !== 'subscribe') return calls.receive(message);
    if (started) throw new Error('Huddle worker cannot start twice');
    started = true;
    secrets = Object.freeze({ ...message.secrets });
    void (message.type === 'subscribe' ? subscribe(message.job) : run(message.job)).then(
      (outputs) => finish({ type: 'finished', outputs }),
      (error: unknown) =>
        finish({
          type: 'failed',
          error:
            (error instanceof Error ? error.message : String(error)).slice(0, 4096) ||
            'Huddle worker failed',
        }),
    );
  },
  disconnected,
);

async function subscribe(job: HuddleTriggerWorkerJob) {
  cancellation = 'signal';
  calls.subscribe();
  const imports = installWorkerImports(job, new URL('./sdk.js', import.meta.url).href);
  const module = (await import(imports.entryUrl)) as { default?: unknown };
  const adapter = HuddleTrigger(module.default as Parameters<typeof HuddleTrigger>[0]);
  imports.checkContract(adapter.contract);
  let reported = false;
  const subscription = await openHuddleTrigger(
    adapter,
    job.component,
    {
      parameters: job.parameters,
      secrets,
      bindings: job.bindings,
      signal: abort.signal,
      log: (message) => console.log(message),
      health: async (health) => {
        reported = true;
        await calls.call({ kind: 'trigger-health', health });
      },
      checkpoint: async (cursor) => {
        await calls.call({ kind: 'trigger-checkpoint', cursor });
      },
      emit: async (emission) =>
        (await calls.call({ kind: 'trigger-emit', emission })) as {
          sequence: number;
          duplicate: boolean;
        },
    },
    job.cursor,
  );
  try {
    abort.signal.throwIfAborted();
    if (!reported) await calls.call({ kind: 'trigger-health', health: { state: 'ready' } });
    if (!writeRuntimeFrame(socket, { type: 'opened' }))
      throw new Error('Trigger owner disconnected');
    await new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    await subscription.close();
  }
  return {};
}

async function run(job: HuddleWorkerJob) {
  cancellation = job.readout ? (job.component.readout?.cancellation ?? 'none') : 'none';
  const imports = installWorkerImports(job, new URL('./sdk.js', import.meta.url).href);
  const module = (await import(imports.entryUrl)) as { default?: unknown };
  if (job.readout) {
    const adapter = HuddleReadout(module.default as Parameters<typeof HuddleReadout>[0]);
    imports.checkContract(adapter.contract);
    const result = await executeHuddleReadout(
      adapter,
      job.component,
      {
        parameters: job.parameters,
        secrets,
        bindings: job.bindings,
        signal: abort.signal,
        log: (message) => console.log(message),
      },
      job.readout.delivery,
      job.readout.mode,
    );
    if (calls.pendingCount) throw new Error('Readout finished with unawaited operations');
    await calls.call({ kind: 'readout-result', result });
    if (result.status !== 'delivered') throw new Error(result.message);
    return result.outputs ?? {};
  }
  const node = HuddleNode(module.default as Parameters<typeof HuddleNode>[0]);
  imports.checkContract(node.contract);
  let sequence = 0;
  const outputs = await executeHuddleNode(node, job.component, {
    inputs: job.inputs,
    parameters: job.parameters,
    secrets,
    bindings: job.bindings,
    signal: abort.signal,
    puddlang: calls.api,
    emit: async (port, value) => {
      await calls.call({ kind: 'emit', sequence: ++sequence, port, value });
    },
  });
  if (calls.pendingCount) throw new Error('Node finished with unawaited operations');
  return outputs;
}

function finish(
  message: { type: 'finished'; outputs: unknown } | { type: 'failed'; error: string },
) {
  if (finished) return;
  finished = true;
  try {
    if (!writeRuntimeFrame(socket, message)) process.exit(1);
    // Flush the final frame before exiting; completion still requires the parent to observe exit.
    socket.end(() => process.exit(message.type === 'finished' ? 0 : 1));
  } catch {
    process.exit(1);
  }
}
