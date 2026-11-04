import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { machNanoseconds, nativeDeltas, nativeResourceProbe } from './native/probe.js';

it('converts Mach ticks without rounding cumulative uint64 values through JS numbers', () => {
  expect(machNanoseconds(9007199254740993n, { numer: 125, denom: 3 })).toBe(375299968947541375n);
});

it.runIf(process.env.PUDDLE_TEST_RUNTIME_NATIVE_METRICS === '1')(
  'calibrates installed-SDK CPU units and observes only this fixture process',
  async () => {
    const result = await nativeResourceProbe();
    if (process.platform !== 'darwin') {
      expect(result.probe).toBeNull();
      expect(result.unavailable).toMatch(/only for macOS/);
      return;
    }
    if (!result.probe) throw new Error(result.unavailable ?? 'Native resource probe unavailable');
    const probe = result.probe;
    try {
      await expect(probe.sample([process.pid])).rejects.toThrow(/Calibrate/);
      const calibration = await probe.calibrate();
      const before = await probe.sample([process.pid]);
      await delay(20);
      const after = await probe.sample([process.pid]);
      const [delta] = nativeDeltas(before, after);
      expect(delta!.self_cpu_ms).toBeGreaterThanOrEqual(0);
      expect(delta!.elapsed_min_ms).toBeGreaterThan(0);
      expect(delta!.elapsed_max_ms).toBeGreaterThanOrEqual(delta!.elapsed_min_ms);
      const changed = structuredClone(after);
      changed.rows[0]!.start_ticks = '1';
      expect(() => nativeDeltas(before, changed)).toThrow(/identity/);
      changed.rows[0] = { ...after.rows[0]!, user_ticks: '0' };
      expect(() => nativeDeltas(before, changed)).toThrow(/decreased/);
      await expect(probe.sample([process.pid, process.pid])).rejects.toThrow(/cohort/);
      console.info(
        JSON.stringify({ native_resource_calibration: calibration, fixture_delta: delta }),
      );
    } finally {
      await probe.close();
    }
  },
  40_000,
);
