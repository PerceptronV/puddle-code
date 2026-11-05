import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { NOTEBOOK_CELL_BRIDGE } from '../../src/notebooks/cell-bridge.js';
import { findCodeExecutable } from '../../src/code/discovery.js';

const python = findCodeExecutable(['python3', 'python']);
it.skipIf(!python)('serialises a linear number of cells and publishes batch cancellation', () => {
  expect(
    execFileSync(python!, [fileURLToPath(new URL('./cell-publication.py', import.meta.url))], {
      input: NOTEBOOK_CELL_BRIDGE,
      encoding: 'utf8',
      timeout: 10000,
    }),
  ).toContain('Linear cell publication and cancellation pass');
});
