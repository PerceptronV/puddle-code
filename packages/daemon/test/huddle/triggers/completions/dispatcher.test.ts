import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RuntimeConnectionLost } from '../../../../src/runtime/transport/client.js';
import { completionDispatcherFixture } from '../../../helpers/huddle/completion-dispatcher.js';
import { untilCompletionOwner } from '../../../helpers/huddle/completion-owner.js';

it('automatically delivers external completions once, observes a lost acknowledgement, and catches up after dispatcher replacement', async () => {
  const f = await completionDispatcherFixture();
  await f.arm();
  const request = f.owner.client.request.bind(f.owner.client);
  let loseReply = true;
  const delivered: number[] = [];
  vi.spyOn(f.owner.client, 'request').mockImplementation(async (command) => {
    const result = await request(command);
    if (command.t === 'completion-events') {
      delivered.push(command.source.cursor.sequence);
      if (loseReply) {
        loseReply = false;
        throw new RuntimeConnectionLost();
      }
    }
    return result;
  });
  await f.append();
  await f.append({ origin: { kind: 'automation', turn: 1 } });
  await f.append({ origin: { kind: 'unknown' } });
  const first = f.createDispatcher();
  first.start();
  await untilCompletionOwner(async () => (await f.owner.sources())[0]?.cursor.sequence === 3);
  await f.completed(1);
  // The delivery succeeded before its acknowledgement was lost. A later page must
  // use the newly observed cursor, never replay the old admission request.
  await f.append();
  f.connections.emit('connected', f.native.binding.runtime_id, f.native.client);
  await untilCompletionOwner(async () => (await f.owner.sources())[0]?.cursor.sequence === 4);
  await f.completed(2);
  expect(delivered).toEqual([0, 3]);
  await first.close();
  await f.append();
  const replacement = f.createDispatcher();
  replacement.start();
  await untilCompletionOwner(async () => (await f.owner.sources())[0]?.cursor.sequence === 5);
  await f.completed(3);
  expect(delivered).toEqual([0, 3, 4]);
  await replacement.close();
  expect(f.connections.listenerCount('connected')).toBe(0);
  expect(f.connections.listenerCount('huddle-connected')).toBe(0);
});

it('fences an in-flight native read during maintenance and resumes from the unchanged cursor', async () => {
  const f = await completionDispatcherFixture();
  await f.arm();
  await f.append();
  const original = f.native.request.getMockImplementation()!;
  let reading = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  f.native.request.mockImplementation(async (command) => {
    if (command.t === 'native-turns') {
      reading = true;
      await pending;
    }
    return original(command);
  });
  const dispatcher = f.createDispatcher();
  dispatcher.start();
  await untilCompletionOwner(() => reading);
  const paused = dispatcher.pause();
  let drained = false;
  const drain = paused.drain().then(() => (drained = true));
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await drain;
  expect((await f.owner.sources())[0]!.cursor.sequence).toBe(0);
  expect(f.owner.client.state!.failure).toBeNull();
  paused.release();
  await untilCompletionOwner(async () => (await f.owner.sources())[0]?.cursor.sequence === 1);
  await f.completed(1);
});

it('waits through native disconnection and pending persistence without failing or rebasing', async () => {
  const f = await completionDispatcherFixture();
  await f.arm();
  f.connections.get.mockReturnValue(undefined);
  const dispatcher = f.createDispatcher();
  const request = vi.spyOn(f.owner.client, 'request');
  dispatcher.start();
  await untilCompletionOwner(() => request.mock.calls.some(([c]) => c.t === 'completion-sources'));
  await f.append();
  // Drain the disconnected scan before asserting its durable outcome.
  const paused = dispatcher.pause();
  await paused.drain();
  expect((await f.owner.sources())[0]!.cursor.sequence).toBe(0);
  expect(f.owner.client.state!.failure).toBeNull();
  f.connections.get.mockReturnValue(f.native.client);
  const original = f.native.request.getMockImplementation()!;
  let pending = true;
  f.native.request.mockImplementation(async (command) => {
    const result = await original(command);
    if (pending && result.t === 'native-turns') result.page.persistencePending = true;
    return result;
  });
  paused.release();
  await untilCompletionOwner(() =>
    f.native.request.mock.calls.some(([c]) => c.t === 'native-turns' && c.after !== null),
  );
  const pendingPause = dispatcher.pause();
  await pendingPause.drain();
  expect((await f.owner.sources())[0]!.cursor.sequence).toBe(0);
  expect(f.owner.client.state!.failure).toBeNull();
  expect(request.mock.calls.some(([c]) => c.t === 'completion-unavailable')).toBe(false);
  pending = false;
  pendingPause.release();
  f.connections.emit('connected', f.native.binding.runtime_id, f.native.client);
  await untilCompletionOwner(async () => (await f.owner.sources())[0]?.cursor.sequence === 1);
  await f.completed(1);
});

it.each(['retention', 'identity'] as const)(
  'fails visibly on a confirmed %s change without moving the baseline',
  async (change) => {
    const f = await completionDispatcherFixture(1);
    await f.arm();
    if (change === 'retention') {
      await f.append();
      await f.append();
    } else {
      f.native.binding.incarnation = randomUUID();
    }
    const request = vi.spyOn(f.owner.client, 'request');
    const dispatcher = f.createDispatcher();
    dispatcher.start();
    await untilCompletionOwner(async () => {
      await f.owner.client.request({ t: 'inspect' });
      return !!f.owner.client.state!.failure;
    });
    expect(f.owner.client.state!.failure).toContain(
      change === 'retention' ? 'observation gap (retention)' : 'no longer available',
    );
    expect(await f.owner.sources()).toEqual([]);
    const delivery = request.mock.calls.find(
      ([c]) => c.t === 'completion-events' || c.t === 'completion-unavailable',
    )![0];
    expect(delivery).toMatchObject({ source: { cursor: { sequence: 0 } } });
    expect(request.mock.calls.some(([c]) => c.t === 'arm' || c.t === 'apply')).toBe(false);
  },
);

it('does not poll stopped huddles and resumes observation when armed', async () => {
  const f = await completionDispatcherFixture();
  const request = vi.spyOn(f.owner.client, 'request');
  const dispatcher = f.createDispatcher();
  dispatcher.start();
  await untilCompletionOwner(() => request.mock.calls.some(([c]) => c.t === 'inspect'));
  // Drain initial discovery; release causes exactly one fresh inspection.
  const paused = dispatcher.pause();
  await paused.drain();
  request.mockClear();
  paused.release();
  await untilCompletionOwner(() => request.mock.calls.some(([c]) => c.t === 'inspect'));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(request.mock.calls.map(([c]) => c.t)).toEqual(['inspect']);
  expect(f.native.request).not.toHaveBeenCalled();
  await f.arm();
  await f.append();
  await untilCompletionOwner(async () => (await f.owner.sources())[0]?.cursor.sequence === 1);
  await f.completed(1);
});
