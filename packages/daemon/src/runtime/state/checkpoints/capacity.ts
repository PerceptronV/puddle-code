/** Bounded identity, terminal, segment, promise and JSON envelope working state. */
export const CHECKPOINT_METADATA_BYTES = 128 * 1024;

export function checkpointMemoryBytes(data: string, jsonBytes: number): number {
  // Retained screen, JSON plus possible newline/flattening copy, and the writer's
  // UTF-8 buffer. Encoded UTF-8 bytes conservatively bound JSON UTF-16 units.
  // Metadata remains charged until the whole task closure settles.
  return CHECKPOINT_METADATA_BYTES + 2 * data.length + 5 * jsonBytes;
}
