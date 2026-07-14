import { errorResponseSchema } from '@puddle/shared';
import { clearToken, tokenStore } from './auth';

/** Typed view of the daemon's uniform error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Authenticated JSON request against the daemon. 401 clears the stored token,
 * which sends the shell back to the token gate.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const res = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiError(401, 'unauthorised', 'invalid or expired token');
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
    }
    throw new ApiError(res.status, 'unknown', `${method} ${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The bearer header for a request against the daemon, or `{}` when signed out. */
export function authHeaders(): Record<string, string> {
  const token = tokenStore.get();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Authenticated request returning the raw `Response`, for callers that need
 * a blob/stream rather than a parsed JSON body (worktree upload/download —
 * `worktree-queries.ts`). Mirrors `api()`'s 401 and error-envelope handling
 * but never reads the body on success, so the caller can stream or blob it.
 */
export async function apiFetchRaw(
  method: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    method,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiError(401, 'unauthorised', 'invalid or expired token');
  }
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
    }
    throw new ApiError(res.status, 'unknown', `${method} ${path} failed with ${res.status}`);
  }
  return res;
}
