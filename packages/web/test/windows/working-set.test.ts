import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  uiStateSnapshotSchema,
  type DesktopWindowsBridge,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';
import { DesktopWorkingSet } from '../../src/features/windows/working-set';

const seed = () => Promise.resolve(uiStateSnapshotSchema.parse({}));
const content = () => ({ capture: () => ({ buffers: [], views: {} }), restore: vi.fn() });
function bridge() {
  let stored: DesktopWorkspaceVersion | null = null;
  return {
    read: vi.fn(async () => stored),
    write: vi.fn<DesktopWindowsBridge['write']>(async (request) => {
      if ((stored?.revision ?? 0) !== request.revision) throw new Error('stale revision');
      stored = structuredClone({ revision: request.revision + 1, content: request.content });
      return stored;
    }),
  };
}
afterEach(() => vi.useRealTimers());

describe('desktop working-set writer', () => {
  it('uses the durable window state ahead of the profile seed', async () => {
    vi.useFakeTimers();
    const io = bridge();
    const existing = uiStateSnapshotSchema.parse({ sidebar_collapsed: true });
    await io.write({
      profileId: '1234567890',
      revision: 0,
      content: { snapshot: existing, buffers: [], views: {} },
    });
    const source = content();
    const model = new DesktopWorkingSet('1234567890', io, source, vi.fn());
    const unusedSeed = vi.fn(seed);
    await model.load(unusedSeed);
    expect(unusedSeed).not.toHaveBeenCalled();
    expect(model.get().sidebar_collapsed).toBe(true);
    expect(source.restore).toHaveBeenCalledOnce();
  });

  it('serialises edits made while a previous write is pending', async () => {
    vi.useFakeTimers();
    const io = bridge();
    const model = new DesktopWorkingSet('1234567890', io, content(), vi.fn());
    await model.load(seed);
    const pending = Promise.withResolvers<DesktopWorkspaceVersion>();
    const write = io.write.getMockImplementation()!;
    io.write.mockImplementationOnce(async (request) => {
      const accepted = await write(request);
      await pending.promise;
      return accepted;
    });
    model.update({ sidebar_collapsed: true });
    const flushed = model.flush();
    model.update({ sessions_collapsed: true });
    expect(io.write).toHaveBeenCalledTimes(2); // seed + in-flight edit
    pending.resolve({ revision: 0, content: { snapshot: await seed(), buffers: [], views: {} } });
    await flushed;
    const stored = await io.read();
    expect(stored?.content.snapshot.sidebar_collapsed).toBe(true);
    expect(stored?.content.snapshot.sessions_collapsed).toBe(true);
    expect(io.write).toHaveBeenCalledTimes(3);
  });

  it('observes a lost write reply without dispatching the mutation twice', async () => {
    vi.useFakeTimers();
    const io = bridge();
    const write = io.write.getMockImplementation()!;
    io.write.mockImplementationOnce(async (request) => {
      await write(request);
      throw new Error('lost reply');
    });
    const model = new DesktopWorkingSet('1234567890', io, content(), vi.fn());
    await model.load(seed);
    expect(io.write).toHaveBeenCalledOnce();
    model.update({ sidebar_collapsed: true });
    await model.flush();
    expect((await io.read())?.revision).toBe(2);
  });

  it('does not accept a different stored snapshot as proof of the attempted write', async () => {
    vi.useFakeTimers();
    const io = bridge();
    const model = new DesktopWorkingSet('1234567890', io, content(), vi.fn());
    await model.load(seed);
    await io.write({
      profileId: '1234567890',
      revision: 1,
      content: { snapshot: await seed(), buffers: [], views: {} },
    });
    model.update({ sidebar_collapsed: true });
    await expect(model.flush()).rejects.toThrow('stale revision');
    expect(model.get().sidebar_collapsed).toBe(true);
    expect((await io.read())?.content.snapshot.sidebar_collapsed).toBe(false);
  });

  it('flushes dirty content, fences edits, and adopts the acknowledged transfer revision', async () => {
    vi.useFakeTimers();
    const io = bridge();
    const source = content();
    const model = new DesktopWorkingSet('1234567890', io, source, vi.fn());
    await model.load(seed);
    const frozen = await model.freeze();
    expect(model.locked()).toBe(true);
    expect(() => model.update({ sidebar_collapsed: true })).toThrow('pending');
    const next = {
      ...frozen,
      revision: frozen.revision + 1,
      content: {
        ...frozen.content,
        snapshot: uiStateSnapshotSchema.parse({ sidebar_collapsed: true }),
      },
    };
    model.adopt(next);
    expect(model.locked()).toBe(false);
    expect(model.get().sidebar_collapsed).toBe(true);
    expect(source.restore).toHaveBeenLastCalledWith(next.content);
  });

  it('captures late buffer notifications during a pending checkpoint and resumes without rollback', async () => {
    vi.useFakeTimers();
    const io = bridge();
    let text = 'initial';
    const source = {
      capture: () => ({
        buffers: [{ session: 's', path: 'a.ts', content: text, baseMtimeMs: 1 }],
        views: {},
      }),
      restore: vi.fn(),
    };
    const model = new DesktopWorkingSet('1234567890', io, source, vi.fn());
    await model.load(seed);
    const pending = Promise.withResolvers<void>();
    const write = io.write.getMockImplementation()!;
    io.write.mockImplementationOnce(async (request) => {
      const saved = await write(request);
      await pending.promise;
      return saved;
    });
    const checkpoint = model.checkpoint();
    await Promise.resolve();
    text = 'latest unsaved text';
    model.changed();
    pending.resolve();
    await checkpoint;
    expect((await io.read())?.content.buffers[0]?.content).toBe(text);
    model.resume();
    expect(model.locked()).toBe(false);
    expect(source.restore).toHaveBeenCalledOnce(); // Initial load only; no stale recapture.
  });
});
