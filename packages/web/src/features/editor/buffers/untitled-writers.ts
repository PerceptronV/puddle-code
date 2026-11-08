const writers = new Map<string, Set<() => Promise<void>>>();

export function registerUntitledWriter(profile: string, name: string, settle: () => Promise<void>) {
  const key = JSON.stringify([profile, name]);
  const entries = writers.get(key) ?? new Set();
  entries.add(settle);
  writers.set(key, entries);
  return () => {
    entries.delete(settle);
    if (!entries.size) writers.delete(key);
  };
}

/** Do not let a debounced or in-flight PUT recreate a draft after its DELETE. */
export async function settleUntitledWriters(profile: string, name: string): Promise<void> {
  await Promise.all(
    [...(writers.get(JSON.stringify([profile, name])) ?? [])].map((settle) => settle()),
  );
}
