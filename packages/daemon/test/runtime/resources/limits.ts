import { z } from 'zod';

/**
 * Plain-shell investigation ceilings, not product guarantees. Calibrated native
 * maxima from four 1/10-owner samples receive 2x margin, rounded up; the single
 * 50-owner sample receives 3x margin. See the dated resource report for scope.
 */
export const resourceBaselineLimits = {
  counts: {
    1: {
      owner_rss_mib: 192,
      adoption_ms: 100,
      owner_cpu_one_core_percent: 1,
      owner_reaped_children_cpu_one_core_percent: 1,
      owner_interrupt_wakeups_per_second: 6,
    },
    10: {
      owner_rss_mib: 1536,
      adoption_ms: 300,
      owner_cpu_one_core_percent: 3,
      owner_reaped_children_cpu_one_core_percent: 3,
      owner_interrupt_wakeups_per_second: 60,
    },
    50: {
      owner_rss_mib: 6144,
      adoption_ms: 2500,
      owner_cpu_one_core_percent: 15,
      owner_reaped_children_cpu_one_core_percent: 15,
      owner_interrupt_wakeups_per_second: 350,
    },
  },
  owner_rss_max_mib: 192,
  owner_descriptors: 32,
  shell_descriptors: 8,
  native_platform: 'darwin',
};

const nativeRates = z.object({
  owners: z
    .object({
      self_cpu_one_core_percent_upper: z.number().nonnegative(),
      self_cpu_one_core_percent_lower: z.number().nonnegative(),
      reaped_children_cpu_one_core_percent_upper: z.number().nonnegative(),
      self_interrupt_wakeups_per_second_upper: z.number().nonnegative(),
    })
    .refine(
      (rates) => rates.self_cpu_one_core_percent_lower <= rates.self_cpu_one_core_percent_upper,
    ),
});

/** Native rates require calibration; coarse ps values never substitute for them. */
export function resourceBaselineRegressions(
  observed: {
    count: number;
    owner_rss_mib: { total: number; max: number };
    owner_descriptors: { counts: number[] | null };
    shell_descriptors: { counts: number[] | null };
    adoption_ms: { max: number };
    native?: unknown;
  },
  context: { platform: NodeJS.Platform; nativeCalibrated: boolean },
): string[] {
  const limits =
    resourceBaselineLimits.counts[observed.count as keyof typeof resourceBaselineLimits.counts];
  if (!limits) throw new Error('Unsupported resource baseline size');
  const failures: string[] = [];
  if (observed.owner_rss_mib.total > limits.owner_rss_mib)
    failures.push('Summed owner RSS exceeds the fixture ceiling');
  if (observed.owner_rss_mib.max > resourceBaselineLimits.owner_rss_max_mib)
    failures.push('Individual owner RSS exceeds the fixture ceiling');
  if (observed.adoption_ms.max > limits.adoption_ms)
    failures.push('Controller adoption exceeds the fixture ceiling');
  if (
    observed.owner_descriptors.counts?.some(
      (count) => count > resourceBaselineLimits.owner_descriptors,
    )
  )
    failures.push('Owner descriptors exceed the fixture ceiling');
  if (
    observed.shell_descriptors.counts?.some(
      (count) => count > resourceBaselineLimits.shell_descriptors,
    )
  )
    failures.push('Shell descriptors exceed the fixture ceiling');
  if (context.platform === resourceBaselineLimits.native_platform) {
    const parsed = nativeRates.safeParse(observed.native);
    if (!context.nativeCalibrated || !parsed.success) {
      failures.push('Calibrated macOS native CPU/wakeup evidence is missing or invalid');
    } else {
      const rates = parsed.data.owners;
      if (rates.self_cpu_one_core_percent_upper > limits.owner_cpu_one_core_percent)
        failures.push('Owner self CPU exceeds the macOS fixture ceiling');
      if (
        rates.reaped_children_cpu_one_core_percent_upper >
        limits.owner_reaped_children_cpu_one_core_percent
      )
        failures.push('Owner reaped-child CPU exceeds the macOS fixture ceiling');
      if (rates.self_interrupt_wakeups_per_second_upper > limits.owner_interrupt_wakeups_per_second)
        failures.push('Owner interrupt wakeups exceed the macOS fixture ceiling');
    }
  }
  return failures;
}
