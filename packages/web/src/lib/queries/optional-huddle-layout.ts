import { huddleDefinitionSchema, type FileResponse } from '@puddle/shared';
import { api, ApiError } from '../transport/api';

/** An absent optional layout is a clean virtual document until an explicit save. */
export async function optionalHuddleLayout(
  sid: string,
  path: string,
  error: unknown,
): Promise<FileResponse> {
  const match = /^\.puddle\/huddle\/([a-f0-9]{32})\/layout\.json$/.exec(path);
  if (!match || !(error instanceof ApiError) || error.status !== 404) throw error;
  // A missing session/worktree/definition is not an empty layout.
  const manifest = await api<FileResponse>(
    'GET',
    `/api/worktrees/${sid}/file?path=${encodeURIComponent(path.replace(/layout\.json$/, 'huddle.json'))}`,
  );
  const parsed = huddleDefinitionSchema.safeParse(manifest.content && JSON.parse(manifest.content));
  if (!parsed.success || parsed.data.id !== match[1]) throw error;
  const content = '{\n  "format": 1,\n  "nodes": {}\n}\n';
  return { path, content, binary: false, size: content.length, mtime_ms: -1 };
}
