import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DiffResponse,
  FileAtResponse,
  FileResponse,
  LogResponse,
  PutFileRequest,
  PutFileResponse,
  ShowCommitResponse,
  TreeResponse,
  UploadResponse,
} from '@puddle/shared';
import { api, apiFetchRaw } from './api';

/**
 * TanStack Query hooks for a session's worktree: file browsing/editing (the
 * explorer, this task) and git inspection (diff/file-at/log/show, consumed
 * by Tasks 8/9 — defined here now so the API surface is complete). Follows
 * `queries.ts`'s conventions (array keys, `enabled` guards, `api<T>()`) but
 * lives in its own file because `queries.ts` is a concurrent-session hotspot.
 */

const LOG_PAGE_SIZE = 50;

export function useWorktreeTree(sid: string | undefined, path: string) {
  return useQuery({
    queryKey: ['wt-tree', sid, path],
    queryFn: () =>
      api<TreeResponse>('GET', `/api/worktrees/${sid}/tree?path=${encodeURIComponent(path)}`),
    enabled: sid !== undefined,
  });
}

export function useWorktreeFile(
  sid: string | undefined,
  path: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['wt-file', sid, path],
    queryFn: () =>
      api<FileResponse>('GET', `/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}`),
    enabled: sid !== undefined && (opts?.enabled ?? true),
  });
}

export function useSaveWorktreeFile(sid: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, ...body }: { path: string } & PutFileRequest) =>
      api<PutFileResponse>(
        'PUT',
        `/api/worktrees/${sid}/file?path=${encodeURIComponent(path)}`,
        body,
      ),
    onSuccess: (_res, { path }) => {
      void qc.invalidateQueries({ queryKey: ['wt-file', sid, path] });
      void qc.invalidateQueries({ queryKey: ['wt-diff', sid] });
    },
  });
}

export function useWorktreeDiff(sid: string | undefined, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['wt-diff', sid],
    queryFn: () => api<DiffResponse>('GET', `/api/worktrees/${sid}/diff`),
    enabled: sid !== undefined && (opts?.enabled ?? true),
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * `staleTime: Infinity` assumes `ref` is either a commit sha or a resolved,
 * stable base (the sha `diff`'s `against` reports, not a moving branch name
 * like `origin/main`) — content at a fixed commit never changes, so this
 * only ever needs fetching once per (sid, ref, path).
 */
export function useFileAt(
  sid: string | undefined,
  ref: string,
  path: string,
  opts?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['wt-file-at', sid, ref, path],
    queryFn: () =>
      api<FileAtResponse>(
        'GET',
        `/api/worktrees/${sid}/file-at?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
      ),
    enabled: sid !== undefined && (opts?.enabled ?? true),
    staleTime: Infinity,
  });
}

export function useWorktreeLog(sid: string | undefined, opts?: { enabled?: boolean }) {
  return useInfiniteQuery({
    queryKey: ['wt-log', sid],
    queryFn: ({ pageParam }) =>
      api<LogResponse>('GET', `/api/worktrees/${sid}/log?limit=${LOG_PAGE_SIZE}&skip=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) =>
      lastPage.has_more ? pages.length * LOG_PAGE_SIZE : undefined,
    enabled: sid !== undefined && (opts?.enabled ?? true),
  });
}

export function useCommitShow(sid: string | undefined, sha: string | undefined) {
  return useQuery({
    queryKey: ['wt-show', sid, sha],
    queryFn: () => api<ShowCommitResponse>('GET', `/api/worktrees/${sid}/show/${sha}`),
    enabled: sid !== undefined && sha !== undefined,
    staleTime: Infinity,
  });
}

/** Drag-in / paste upload into a worktree directory (SPEC §8). */
export async function uploadFiles(
  sid: string,
  dir: string,
  files: File[],
): Promise<UploadResponse> {
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);
  const res = await apiFetchRaw(
    'POST',
    `/api/worktrees/${sid}/upload?dir=${encodeURIComponent(dir)}`,
    { body: form },
  );
  return (await res.json()) as UploadResponse;
}

/**
 * Picks the download's filename from the daemon's `content-disposition`
 * header (`worktree-files.ts`'s `contentDisposition`, which always sends the
 * RFC 5987 `filename*=UTF-8''…` form) with a plain `filename=…` fallback for
 * any other server, and `fallback` (the requested path's basename) when the
 * header is missing entirely. Pure so it's testable without a DOM.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const starred = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (starred?.[1]) {
    try {
      return decodeURIComponent(starred[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^"; ]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}

/** Downloads a worktree path (file, or zipped directory) to the browser's Downloads (SPEC §8). */
export async function downloadPath(sid: string, path: string): Promise<void> {
  const res = await apiFetchRaw(
    'GET',
    `/api/worktrees/${sid}/download?path=${encodeURIComponent(path)}`,
  );
  const blob = await res.blob();
  const fallback = path.split('/').filter(Boolean).pop() ?? 'worktree';
  const filename = filenameFromDisposition(res.headers.get('content-disposition'), fallback);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
