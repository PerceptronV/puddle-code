import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAdmission } from '../../../src/host/lifecycle/admission.js';

afterEach(() => vi.useRealTimers());

describe('host request admission', () => {
  it('drains admitted work, refuses new work and resumes only on release', async () => {
    const admission = new HostAdmission();
    let finish!: () => void;
    const running = admission.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hold = admission.pause();
    const drained = vi.fn();
    const drain = hold.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    const forbidden = vi.fn();
    await expect(admission.run(forbidden)).rejects.toMatchObject({
      status: 503,
      code: 'host_maintenance',
    });
    expect(forbidden).not.toHaveBeenCalled();
    finish();
    await running;
    await drain;
    expect(() => admission.enter()).toThrow(/maintenance/);
    hold.release();
    await expect(admission.run(async () => 'ready')).resolves.toBe('ready');
  });

  it('releases failed work and does not double count repeated releases', async () => {
    const admission = new HostAdmission();
    const release = admission.enter();
    release();
    release();
    await expect(
      admission.run(async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    admission.close();
    await admission.drain();
  });

  it('keeps a timed-out hold closed until explicitly released', async () => {
    vi.useFakeTimers();
    const admission = new HostAdmission();
    const release = admission.enter();
    const hold = admission.pause();
    const drain = expect(hold.drain(100)).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(100);
    await drain;
    expect(() => admission.assertOpen()).toThrow(/maintenance/);
    release();
    await hold.drain();
    hold.release();
    expect(() => admission.assertOpen()).not.toThrow();
  });

  it('rejects released holds without reopening a newer pause or a closed host', async () => {
    const admission = new HostAdmission();
    const release = admission.enter();
    const first = admission.pause();
    const abandoned = expect(first.drain()).rejects.toThrow(/released/);
    first.release();
    await abandoned;
    const second = admission.pause();
    first.release();
    expect(() => admission.assertOpen()).toThrow(/maintenance/);
    admission.close();
    second.release();
    expect(() => admission.assertOpen()).toThrow(/maintenance/);
    release();
    await admission.drain();
    await expect(first.drain()).rejects.toThrow(/released/);
  });

  it('requires a fence and bounds deadlines and waiters', async () => {
    const admission = new HostAdmission();
    expect(() => admission.drain()).toThrow(/Close admission/);
    const release = admission.enter();
    const hold = admission.pause();
    expect(() => admission.pause()).toThrow(/maintenance/);
    for (const timeout of [0, -1, Infinity, NaN, 60_001]) {
      await expect(hold.drain(timeout)).rejects.toThrow(/deadline/);
    }
    const pending = Array.from({ length: 8 }, () => hold.drain());
    await expect(hold.drain()).rejects.toThrow(/Too many/);
    release();
    await Promise.all(pending);
    await hold.drain();
    hold.release();
  });
});

it('holds bounded programme admissions, drains dispatched work and drops aborted or closed waiters', async () => {
  const admission = new HostAdmission();
  const accepted = admission.enter();
  const hold = admission.pause();
  const abort = new AbortController();
  const aborted = expect(admission.waitForOpen(abort.signal)).rejects.toThrow('cancelled');
  abort.abort(new Error('cancelled'));
  await aborted;
  let entered = false;
  const waiting = admission.waitForOpen(new AbortController().signal).then((release) => {
    entered = true;
    return release;
  });
  accepted();
  await hold.drain();
  expect(entered).toBe(false);
  hold.release();
  const release = await waiting;
  expect(entered).toBe(true);
  release();
  const final = admission.pause();
  const cancelled = expect(
    admission.waitForOpen(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'host_maintenance' });
  admission.close();
  final.release();
  await cancelled;
  await admission.drain();
});

it('bounds undispatched programme waiters separately from active work', async () => {
  const admission = new HostAdmission();
  const hold = admission.pause();
  const aborts = Array.from({ length: 1024 }, () => new AbortController());
  const waiters = aborts.map((abort) => admission.waitForOpen(abort.signal));
  const finished = Promise.allSettled(waiters);
  await expect(admission.waitForOpen(new AbortController().signal)).rejects.toMatchObject({
    code: 'host_maintenance',
  });
  await hold.drain();
  for (const abort of aborts) abort.abort(new Error('cancelled'));
  expect((await finished).every((result) => result.status === 'rejected')).toBe(true);
  hold.release();
});
