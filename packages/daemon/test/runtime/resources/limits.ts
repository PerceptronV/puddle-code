/** Fixture-only investigation ceilings from the 4 November 2026 macOS baseline. */
export const resourceBaselineLimits = {
  counts: {
    1: { owner_rss_mib: 192, adoption_ms: 100 },
    10: { owner_rss_mib: 1536, adoption_ms: 300 },
    50: { owner_rss_mib: 6144, adoption_ms: 2500 },
  },
  owner_rss_max_mib: 192,
  owner_descriptors: 32,
  shell_descriptors: 8,
  cpu: null,
  wakeups: null,
};

/** Missing descriptor probes remain explicit gaps; CPU precision does not support a budget. */
export function resourceBaselineRegressions(observed: {
  count: number;
  owner_rss_mib: { total: number; max: number };
  owner_descriptors: { counts: number[] | null };
  shell_descriptors: { counts: number[] | null };
  adoption_ms: { max: number };
}): string[] {
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
  return failures;
}
