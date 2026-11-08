/** Portable native window layouts; old rows remain ordinary single-tree layouts. */
export const migration042 = {
  version: 42,
  name: 'window-arrangements',
  sql: `ALTER TABLE layouts ADD COLUMN window_arrangement TEXT;`,
};
