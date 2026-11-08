import { spawn, type ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import {
  HUDDLE_WORKER_LIMITS,
  huddleWorkerJobSchema,
  huddleTriggerWorkerJobSchema,
  huddleWorkerMessageSchema,
  huddleWorkerInputSchema,
  type HuddleJson,
  type HuddleWorkerJob,
  type HuddleTriggerWorkerJob,
  type HuddleWorkerRequest,
} from '@puddle/shared';
import { readRuntimeFrames, writeRuntimeFrame } from '../../transport/framing.js';
import { runtimeJsonBytes } from '../../transport/encoding.js';
import { RuntimeTransportBuffers } from '../../transport/buffers.js';
import type { RuntimeByteAllowance } from '../../resources/budget.js';
import { checkedWorkerSource } from './source.js';

export interface HuddleWorkerOptions {
  /** Both paths come from the owner's pinned runtime release, never project files. */
  nodePath: string;
  entryPath: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  allowance?: RuntimeByteAllowance;
  /** The owner validates scope and commits effects/emissions before resolving. */
  request(message: HuddleWorkerRequest, signal: AbortSignal): Promise<HuddleJson>;
  log?(stream: 'stdout' | 'stderr', text: string): void;
  opened?(): void;
}

/** Failure to observe process exit is not permission to replay this invocation. */
export class HuddleWorkerTerminationUnknown extends Error {
  constructor(readonly pid: number | undefined) {
    super('Huddle worker termination is unconfirmed; retain its invocation for recovery');
    this.name = 'HuddleWorkerTerminationUnknown';
  }
}

export interface HuddleWorkerHandle {
  result: Promise<Record<string, HuddleJson>>;
  /** Resolves only on a child exit event or a positively failed spawn. */
  exited: Promise<void>;
  cancel(reason?: string): void;
}

/** One bounded child process; the lifecycle owner retains responsibility for its service scope. */
export function startHuddleWorker(
  input: HuddleWorkerJob | HuddleTriggerWorkerJob,
  options: HuddleWorkerOptions,
): HuddleWorkerHandle {
  options.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 86_400_000
  )
    throw new Error('Invalid huddle worker deadline');
  const continuous = 'subscriptionId' in input;
  const job = continuous
    ? huddleTriggerWorkerJobSchema.parse(input)
    : huddleWorkerJobSchema.parse(input);
  checkedWorkerSource(job);
  const start = { type: continuous ? 'subscribe' : 'start', job };
  runtimeJsonBytes(start); // Reject an oversized encoded bundle before spawning a process.
  const buffers = new RuntimeTransportBuffers(options.allowance);
  const abort = new AbortController();
  const pending = new Set<string>();
  const seen = new Set<string>();
  let resolveResult!: (value: Record<string, HuddleJson>) => void;
  let rejectResult!: (error: Error) => void;
  let resolveExit!: () => void;
  const result = new Promise<Record<string, HuddleJson>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let child: ChildProcess;
  let socket: Socket;
  let final: Record<string, HuddleJson> | undefined;
  let failure: Error | undefined;
  let exitObserved = false;
  let exitCode: number | null = null;
  let settled = false;
  let channelClosed = false;
  let logged = 0;
  let logWindow = performance.now();
  let requestWindow = performance.now();
  let requestCount = 0;
  let sequence = 0;
  let opened = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopRead: (() => void) | undefined;
  const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

  const cleanup = () => {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    clearTimeout(observationTimer);
    options.signal?.removeEventListener('abort', cancelled);
    stopRead?.();
    socket?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  };
  const settle = () => {
    if (settled || !exitObserved || (!failure && final === undefined && !channelClosed)) return;
    settled = true;
    cleanup();
    if (failure) rejectResult(failure);
    else if (exitCode !== 0 || final === undefined)
      rejectResult(new Error('Huddle worker exited without a successful result'));
    else resolveResult(final);
  };
  const fail = (error: unknown) => {
    if (settled) return;
    failure ??= errorOf(error);
    abort.abort(failure);
    if (!exitObserved && child) {
      try {
        if (socket && !socket.destroyed)
          writeRuntimeFrame(
            socket,
            { type: 'cancel', reason: failure.message.slice(0, 4096) || 'Cancelled' },
            buffers.outgoing,
            buffers.encoding,
          );
      } catch {
        /* Termination below also handles a saturated channel. */
      }
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
      observationTimer ??= setTimeout(() => {
        if (!exitObserved && !settled) {
          settled = true;
          cleanup();
          rejectResult(new HuddleWorkerTerminationUnknown(child.pid));
        }
      }, 5000);
    }
    settle();
  };
  const cancelled = () => fail(options.signal?.reason ?? new Error('Huddle worker cancelled'));
  const send = (message: unknown) => {
    const parsed = huddleWorkerInputSchema.parse(message);
    if (!writeRuntimeFrame(socket, parsed, buffers.outgoing, buffers.encoding))
      throw new Error('Huddle worker transport closed');
  };
  const receive = (raw: unknown) => {
    if (failure || settled) return;
    const message = huddleWorkerMessageSchema.parse(raw);
    if (final !== undefined) throw new Error('Huddle worker sent data after completion');
    if (message.type === 'opened') {
      if (!continuous || opened) throw new Error('Unexpected subscription readiness');
      opened = true;
      clearTimeout(deadline);
      options.opened?.();
      return;
    }
    if (message.type === 'failed') return fail(new Error(message.error));
    if (message.type === 'finished') {
      if (pending.size) throw new Error('Node finished with unawaited owner requests');
      final = message.outputs;
      settle();
      return;
    }
    if (continuous && performance.now() - requestWindow >= 1000) {
      requestWindow = performance.now();
      requestCount = 0;
    }
    if (
      pending.size >= HUDDLE_WORKER_LIMITS.pending ||
      pending.has(message.id) ||
      (continuous
        ? // Sender/receiver windows need not align; permit two bounded sender bursts.
          message.sequence !== sequence + 1 ||
          ++requestCount > 2 * HUDDLE_WORKER_LIMITS.subscriptionRequestsPerSecond
        : seen.size >= HUDDLE_WORKER_LIMITS.requests || seen.has(message.id))
    )
      throw new Error('Huddle worker request identity/capacity exceeded');
    if (continuous) sequence = message.sequence!;
    else seen.add(message.id);
    pending.add(message.id);
    const task = async () => {
      if (
        message.action.kind === 'operation' &&
        (!job.component.capabilities.includes('sessions') || !job.bindings['worktree'])
      )
        throw new Error(
          'Agent operations need a sessions capability and resolved explicit worktree',
        );
      abort.signal.throwIfAborted();
      return options.request(message, abort.signal);
    };
    void task()
      .then(
        (value) => {
          if (!abort.signal.aborted && !settled) send({ type: 'reply', id: message.id, value });
        },
        (error: unknown) => {
          if (!abort.signal.aborted && !settled)
            send({
              type: 'reject',
              id: message.id,
              error: errorOf(error).message.slice(0, 4096) || 'Owner request failed',
            });
        },
      )
      .catch(fail)
      .finally(() => pending.delete(message.id));
  };

  try {
    child = spawn(
      options.nodePath,
      [`--max-old-space-size=${HUDDLE_WORKER_LIMITS.heapMiB}`, options.entryPath],
      {
        cwd: options.cwd,
        env: options.environment ?? {},
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      },
    );
    socket = child.stdio[3] as Socket;
    child.once('error', (error) => {
      if (child.pid === undefined) {
        exitObserved = true;
        resolveExit();
      }
      fail(error);
    });
    child.once('exit', (code) => {
      exitObserved = true;
      exitCode = code;
      resolveExit();
      clearTimeout(killTimer);
      clearTimeout(observationTimer);
      // A final frame may still be buffered. Never wait on inherited stdout pipes.
      observationTimer = setTimeout(() => {
        channelClosed = true;
        settle();
      }, 1000);
      settle();
    });
    socket.on('error', fail);
    socket.once('close', () => {
      channelClosed = true;
      if (final === undefined && !failure)
        fail(new Error('Huddle worker disconnected without a result'));
      else settle();
    });
    stopRead = readRuntimeFrames(socket, receive, fail, buffers.incoming, buffers.decoding);
    for (const stream of ['stdout', 'stderr'] as const)
      child[stream]?.on('data', (chunk: Buffer) => {
        if (settled || failure) return;
        if (continuous && performance.now() - logWindow >= 60_000) {
          logWindow = performance.now();
          logged = 0;
        }
        logged += chunk.byteLength;
        if (logged > HUDDLE_WORKER_LIMITS.logBytes)
          return fail(new Error('Huddle worker log limit exceeded'));
        try {
          options.log?.(stream, chunk.toString('utf8'));
        } catch (error) {
          fail(error);
        }
      });
    options.signal?.addEventListener('abort', cancelled, { once: true });
    deadline = setTimeout(
      () => fail(new Error('Huddle worker deadline exceeded')),
      options.timeoutMs,
    );
    if (options.signal?.aborted) cancelled();
    else send(start);
  } catch (error) {
    if (!child!) {
      exitObserved = true;
      resolveExit();
    }
    fail(error);
  }
  return {
    result,
    exited,
    cancel: (reason = 'Huddle worker cancelled') => fail(new Error(reason)),
  };
}
