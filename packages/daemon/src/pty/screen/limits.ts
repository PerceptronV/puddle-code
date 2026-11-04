/** Finite buffer/file allowances, not a promise about total process memory. */
export const SCREEN_LIMITS = Object.freeze({
  fileBytes: 4 * 1024 * 1024,
  scratchFiles: 2,
  snapshotBytes: 4 * 1024 * 1024 - 4096,
  parserBytes: 16 * 1024 * 1024,
  parserActions: 2048,
  captureBytes: 16 * 1024,
  captureActions: 64,
  transientBytes: 96 * 1024 * 1024,
  transientOperations: 2,
  waitingOperations: 32,
  // Includes ANSI/JSON strings, UTF-8 buffers and serialiser intermediate rows.
  operationBytes: 48 * 1024 * 1024,
  scrollbackLines: 20_000,
});

export function screenActionBytes(data = ''): number {
  return Buffer.byteLength(data) + 2 * data.length + 128;
}
