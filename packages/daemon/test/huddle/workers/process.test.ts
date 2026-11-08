import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { huddleComponentSchema } from '@puddle/shared';
import { workerJob, workerTestHarness } from '../../helpers/huddle/worker.js';

const workers = workerTestHarness();
const wrap = (body: string) =>
  `import {HuddleNode} from 'puddlang/huddle'; export default HuddleNode({contract:'./node.json', async run(context) { ${body} }});`;

describe('bounded huddle worker process', () => {
  it('waits for durable event acknowledgement before accepting completion', async () => {
    let acknowledge!: () => void;
    let observed!: () => void;
    const requested = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const request = vi.fn(async (message) => {
      expect(message.action).toEqual({ kind: 'emit', sequence: 1, port: 'turn', value: 7 });
      observed();
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      return null;
    });
    const worker = workers.start(
      workerJob(wrap('await context.emit("turn", 7); return {completed: 42};')),
      { request },
    );
    let completed = false;
    void worker.result.then(() => {
      completed = true;
    });
    await requested;
    expect(completed).toBe(false);
    acknowledge();
    await expect(worker.result).resolves.toEqual({ completed: 42 });
    expect(request).toHaveBeenCalledOnce();
  });

  it('reuses the agent client with correlated owner calls and structured replies', async () => {
    const component = huddleComponentSchema.parse({
      ...workerJob('').component,
      capabilities: ['sessions'],
      parameters: { worktree: { schema: { type: 'string' }, editor: 'worktree' } },
    });
    const request = vi.fn(async ({ action }) => {
      if (action.operation.op === 'attach')
        return { runtime_id: randomUUID(), session_id: randomUUID() };
      expect(action.operation.op).toBe('ask');
      expect(action.operation.request.prompt).toContain('review');
      return '{"value":42}';
    });
    const worker = workers.start(
      workerJob(
        `
      import {HuddleNode, attach, z} from 'puddlang';
      export default HuddleNode({contract:'./node.json', async run() {
        const agent = await attach('selected');
        const reply = await agent.ask({prompt:'review', schema:z.object({value:z.number()})});
        return {completed:reply.value};
      }});
    `,
        { component, parameters: { worktree: '/fixture' }, bindings: { worktree: '/fixture' } },
      ),
      { request },
    );
    await expect(worker.result).resolves.toEqual({ completed: 42 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(new Set(request.mock.calls.map(([message]) => message.id)).size).toBe(2);
  });

  it('requires declared session authority and a resolved worktree before calling the owner', async () => {
    const request = vi.fn(async () => null);
    const worker = workers.start(
      workerJob(wrap('await context.puddlang.attach("selected"); return {completed:42};')),
      { request },
    );
    await expect(worker.result).rejects.toThrow('sessions capability');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects unawaited owner requests and aborts their caller signal', async () => {
    let signal: AbortSignal | undefined;
    const worker = workers.start(
      workerJob(wrap('void context.emit("turn", 1); return {completed:42};')),
      {
        request: async (_message, current) => {
          signal = current;
          return new Promise((resolve) =>
            current.addEventListener('abort', () => resolve(null), { once: true }),
          );
        },
      },
    );
    await expect(worker.result).rejects.toThrow('unawaited emissions');
    expect(signal?.aborted).toBe(true);
  });

  it('terminates a CPU-bound script on its deadline without freezing the parent', async () => {
    let entered = false;
    const worker = workers.start(
      workerJob(wrap('process.stdout.write("entered-loop"); while (true) {}')),
      {
        timeoutMs: 1000,
        log: (_stream, text) => {
          if (text.includes('entered-loop')) entered = true;
        },
      },
    );
    await expect(worker.result).rejects.toThrow('deadline exceeded');
    expect(entered).toBe(true);
    await worker.exited;
  });

  it('rejects an unawaited agent operation even when no event is pending', async () => {
    const component = huddleComponentSchema.parse({
      ...workerJob('').component,
      capabilities: ['sessions'],
      parameters: { worktree: { schema: { type: 'string' }, editor: 'worktree' } },
    });
    const worker = workers.start(
      workerJob(wrap('void context.puddlang.attach("selected"); return {completed:42};'), {
        component,
        parameters: { worktree: '/fixture' },
        bindings: { worktree: '/fixture' },
      }),
      {
        request: async (_message, signal) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve(null), { once: true }),
          ),
      },
    );
    await expect(worker.result).rejects.toThrow('unawaited operations');
  });

  it('supports explicit cancellation and never accepts a result after cancellation', async () => {
    const abort = new AbortController();
    const worker = workers.start(
      workerJob(wrap('await new Promise(() => {}); return {completed:42};')),
      { signal: abort.signal },
    );
    abort.abort(new Error('User interrupted'));
    await expect(worker.result).rejects.toThrow('User interrupted');
    await worker.exited;
  });

  it('observes a failed spawn without leaving an unknown live worker', async () => {
    const worker = workers.start(workerJob(wrap('return {completed:42};')), {
      nodePath: '/puddle-fixture-missing-node',
    });
    await expect(worker.result).rejects.toThrow();
    await worker.exited;
  });

  it('bounds runaway logging and reports child crashes as failures', async () => {
    const noisy = workers.start(
      workerJob(
        wrap(
          'const {writeSync} = await import("node:fs"); while(true) writeSync(1, "x".repeat(8192));',
        ),
      ),
    );
    await expect(noisy.result).rejects.toThrow('log limit');
    const crashed = workers.start(workerJob(wrap('process.kill(process.pid, "SIGKILL");')));
    await expect(crashed.result).rejects.toThrow(/without.*result/);
  });
});
