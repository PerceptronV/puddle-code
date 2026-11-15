import { expect, it } from 'vitest';
import { RequestTiming } from '../../../src/lib/transport/request-timing';

function fixture() {
  let now = 0;
  const timing = new RequestTiming(() => now);
  const advance = (ms: number) => {
    now += ms;
  };
  const request = (ms: number) => {
    const complete = timing.start();
    advance(ms);
    complete();
  };
  return { timing, advance, request };
}

it('keeps fast links at their normal cadence and adapts continuously to slower reads', () => {
  for (const duration of [10, 100, 1000, 5000, 10_000]) {
    const { timing, request } = fixture();
    request(duration);
    expect(timing.interval(3000)).toBe(Math.max(3000, Math.min(30_000, duration * 4)));
  }
});

it('recovers after congestion and preserves slower background/heartbeat intervals', () => {
  const { timing, request } = fixture();
  request(5000);
  expect(timing.interval(3000)).toBe(20_000);
  expect(timing.interval(60_000)).toBe(60_000);
  for (let i = 0; i < 15; i++) request(20);
  expect(timing.interval(3000)).toBe(3000);
});

it('expires stale observations and ignores completions from a previous host', () => {
  const { timing, request, advance } = fixture();
  request(5000);
  advance(60_001);
  expect(timing.interval(3000)).toBe(3000);
  const old = timing.start();
  timing.reset();
  advance(10_000);
  old();
  expect(timing.interval(3000)).toBe(3000);
});
