import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resourceBaselineLimits, resourceBaselineRegressions } from './limits.js';

type Observation = Parameters<typeof resourceBaselineRegressions>[0];
const macOS = { platform: 'darwin' as const, nativeCalibrated: true };
const evidenceFailure = 'Calibrated macOS native CPU/wakeup evidence is missing or invalid';
const metrics = [
  {
    rate: 'self_cpu_one_core_percent_upper',
    limit: 'owner_cpu_one_core_percent',
    failure: 'Owner self CPU exceeds the macOS fixture ceiling',
  },
  {
    rate: 'reaped_children_cpu_one_core_percent_upper',
    limit: 'owner_reaped_children_cpu_one_core_percent',
    failure: 'Owner reaped-child CPU exceeds the macOS fixture ceiling',
  },
  {
    rate: 'self_interrupt_wakeups_per_second_upper',
    limit: 'owner_interrupt_wakeups_per_second',
    failure: 'Owner interrupt wakeups exceed the macOS fixture ceiling',
  },
] as const;

function observation(count: 1 | 10 | 50 = 1) {
  return {
    count,
    owner_rss_mib: { total: 0, max: 0 },
    owner_descriptors: { counts: [26] },
    shell_descriptors: { counts: [4] },
    adoption_ms: { max: 0 },
    native: {
      owners: {
        self_cpu_one_core_percent_upper: 0,
        self_cpu_one_core_percent_lower: 0,
        reaped_children_cpu_one_core_percent_upper: 0,
        self_interrupt_wakeups_per_second_upper: 0,
      },
    },
  };
}

describe('calibrated fixture resource ceilings', () => {
  // Measured fields preserved from the archived reports; provenance lives in the fixture.
  const { observations: rows } = JSON.parse(
    readFileSync(new URL('./calibrated-observations.json', import.meta.url), 'utf8'),
  ) as {
    observations: Array<{
      name: string;
      count: number;
      result: Observation;
      context: { platform: NodeJS.Platform; nativeCalibrated: boolean };
    }>;
  };

  it('retains all nine calibrated observations, including partial runs', () => {
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.count === 1)).toHaveLength(4);
    expect(rows.filter((row) => row.count === 10)).toHaveLength(4);
    expect(rows.filter((row) => row.count === 50)).toHaveLength(1);
  });
  it.each(rows)('accepts recorded $name scale $count', ({ result, context }) => {
    expect(context).toEqual(macOS);
    expect(resourceBaselineRegressions(result, context)).toEqual([]);
  });

  for (const count of [1, 10, 50] as const) {
    it.each(metrics)(
      `compares ${count}-owner $rate independently at and above its ceiling`,
      (metric) => {
        const row = observation(count);
        row.native.owners[metric.rate] = resourceBaselineLimits.counts[count][metric.limit];
        expect(resourceBaselineRegressions(row, macOS)).toEqual([]);
        row.native.owners[metric.rate] += 0.000001;
        expect(resourceBaselineRegressions(row, macOS)).toEqual([metric.failure]);
      },
    );
  }

  it('reports all native regressions without offsetting self CPU against reaped children', () => {
    const row = observation(10);
    for (const metric of metrics)
      row.native.owners[metric.rate] = resourceBaselineLimits.counts[10][metric.limit] + 1;
    expect(resourceBaselineRegressions(row, macOS)).toEqual(
      metrics.map((metric) => metric.failure),
    );
  });

  it.each([undefined, null, {}, { owners: null }, { owners: {} }])(
    'refuses missing macOS evidence %j',
    (native) => {
      expect(resourceBaselineRegressions({ ...observation(), native }, macOS)).toEqual([
        evidenceFailure,
      ]);
    },
  );
  for (const rate of [
    ...metrics.map((metric) => metric.rate),
    'self_cpu_one_core_percent_lower',
  ] as const) {
    it.each([undefined, null, NaN, Infinity, -1, '0'])(
      `refuses malformed ${rate} = %j`,
      (value) => {
        const row = observation();
        const native = { owners: { ...row.native.owners, [rate]: value } };
        expect(resourceBaselineRegressions({ ...row, native }, macOS)).toEqual([evidenceFailure]);
      },
    );
  }
  it('refuses reversed CPU brackets and uncalibrated rates', () => {
    const row = observation();
    row.native.owners.self_cpu_one_core_percent_lower = 1;
    expect(resourceBaselineRegressions(row, macOS)).toEqual([evidenceFailure]);
    expect(
      resourceBaselineRegressions(observation(), { ...macOS, nativeCalibrated: false }),
    ).toEqual([evidenceFailure]);
  });
  it('never substitutes coarse ps CPU or missing values as zero for macOS', () => {
    const row = {
      ...observation(),
      native: null,
      owner_cpu_one_core_percent: 0,
      owner_and_reaped_children_cpu_one_core_percent: 0,
    };
    expect(resourceBaselineRegressions(row, macOS)).toEqual([evidenceFailure]);
  });
  it('keeps Linux native limits out of scope while enforcing the existing fixture gates', () => {
    const context = { platform: 'linux' as const, nativeCalibrated: false };
    const row = { ...observation(), native: null };
    expect(resourceBaselineRegressions(row, context)).toEqual([]);
    row.owner_rss_mib.total = resourceBaselineLimits.counts[1].owner_rss_mib + 1;
    expect(resourceBaselineRegressions(row, context)).toEqual([
      'Summed owner RSS exceeds the fixture ceiling',
    ]);
    expect(resourceBaselineLimits.native_platform).toBe('darwin');
  });
});
