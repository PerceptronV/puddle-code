/** Work budgets count directory entries/names, never the size of file contents (which are not read). */
export const RUNTIME_INVENTORY_LIMITS = {
  passEntries: 64,
  passNameBytes: 16 * 1024,
  passMs: 20,
  entries: 16_384,
  directories: 1024,
  nameBytes: 1024 * 1024,
  depth: 8,
  pathBytes: 4096,
} as const;
export type RuntimeInventoryLimits = {
  -readonly [K in keyof typeof RUNTIME_INVENTORY_LIMITS]: number;
};

export function inventoryLimits(
  overrides: Partial<RuntimeInventoryLimits>,
): RuntimeInventoryLimits {
  const result: RuntimeInventoryLimits = { ...RUNTIME_INVENTORY_LIMITS };
  for (const key of Object.keys(result) as Array<keyof RuntimeInventoryLimits>) {
    const value = overrides[key] ?? result[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > result[key])
      throw new Error(`Invalid runtime inventory limit: ${key}`);
    result[key] = value;
  }
  return result;
}
