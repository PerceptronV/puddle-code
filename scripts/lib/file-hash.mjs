import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Hash archives with bounded buffers, propagating open and read failures. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
