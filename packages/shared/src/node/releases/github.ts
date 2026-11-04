import { z } from 'zod';
import { releaseRepositorySchema } from '../../installation/catalogue.js';
export { releaseRepositorySchema } from '../../installation/catalogue.js';

const assetSchema = z.object({
  name: z.string().min(1).max(256),
  browser_download_url: z
    .string()
    .max(2048)
    .url()
    .refine((value) => value.startsWith('https://')),
});
const releaseSchema = z.object({
  tag_name: z
    .string()
    .max(129)
    .regex(/^v?[0-9]+\.[0-9]+\.[0-9]+$/),
  draft: z.literal(false).optional(),
  prerelease: z.literal(false).optional(),
  assets: z.array(assetSchema).max(1024).default([]),
});
export type ReleaseAsset = z.infer<typeof assetSchema>;

/** One bounded latest-stable lookup, shared by host, CLI and desktop update discovery. */
export async function latestGitHubRelease(
  repository: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ version: string; assets: ReleaseAsset[] }> {
  releaseRepositorySchema.parse(repository);
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const response = await (options.fetchFn ?? fetch)(
    `https://api.github.com/repos/${repository}/releases/latest`,
    {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'puddle' },
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`release lookup failed (HTTP ${response.status})`);
  }
  if (!response.body) throw new Error('Release lookup returned no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('Release metadata exceeds its limit');
      chunks.push(value);
    }
    const release = releaseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return { version: release.tag_name.replace(/^v/, ''), assets: release.assets };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
