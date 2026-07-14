/**
 * `worktree-queries.ts`'s hooks are TanStack Query hooks and can't be driven
 * without a React renderer (same limitation `use-ui-state.ts`'s tests
 * document — no `@testing-library/react` dependency here). What IS testable
 * without a DOM or React:
 *   - `filenameFromDisposition` (pure): both `content-disposition` forms the
 *     daemon and the wider world can send, plus the missing-header fallback.
 *   - `apiFetchRaw` (`api.ts`) end to end against a mocked `fetch`: the 401
 *     → `clearToken` path, and the non-OK → `ApiError` path with the parsed
 *     error envelope. `uploadFiles`/`downloadPath` are thin wrappers over
 *     `apiFetchRaw` plus DOM/blob APIs (`FormData`, `URL.createObjectURL`,
 *     an `<a download>` click) not exercised here — manual check, see the
 *     task report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filenameFromDisposition } from '../src/lib/worktree-queries';

describe('filenameFromDisposition', () => {
  it("decodes the RFC 5987 filename*=UTF-8'' form (what the daemon sends)", () => {
    const header = "attachment; filename*=UTF-8''caf%C3%A9%20notes.txt";
    expect(filenameFromDisposition(header, 'fallback.txt')).toBe('café notes.txt');
  });

  it('falls back to the plain filename= form when present', () => {
    expect(filenameFromDisposition('attachment; filename="report.zip"', 'fallback')).toBe(
      'report.zip',
    );
  });

  it('reads an unquoted plain filename=', () => {
    expect(filenameFromDisposition('attachment; filename=report.zip', 'fallback')).toBe(
      'report.zip',
    );
  });

  it('uses the fallback when the header is missing', () => {
    expect(filenameFromDisposition(null, 'notes.txt')).toBe('notes.txt');
  });

  it('uses the fallback when the header has neither recognised form', () => {
    expect(filenameFromDisposition('attachment', 'notes.txt')).toBe('notes.txt');
  });

  it('uses the fallback when the starred value is not validly percent-encoded', () => {
    const header = "attachment; filename*=UTF-8''%";
    expect(filenameFromDisposition(header, 'fallback.txt')).toBe('fallback.txt');
  });
});

function storageStub(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe('apiFetchRaw', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storageStub());
    localStorage.setItem('puddle.token', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('attaches the bearer token from tokenStore', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetchRaw } = await import('../src/lib/api');

    await apiFetchRaw('GET', '/api/worktrees/s1/download?path=a');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/worktrees/s1/download?path=a',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
      }),
    );
  });

  it('on 401, clears the stored token and throws ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const { apiFetchRaw, ApiError } = await import('../src/lib/api');

    await expect(apiFetchRaw('GET', '/api/worktrees/s1/download?path=a')).rejects.toThrow(ApiError);
    expect(localStorage.getItem('puddle.token')).toBeNull();
  });

  it('on a non-OK response, throws ApiError with the parsed error envelope', async () => {
    const body = JSON.stringify({ error: { code: 'not_found', message: 'path does not exist' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 404 })));
    const { apiFetchRaw, ApiError } = await import('../src/lib/api');

    const err = await apiFetchRaw('GET', '/api/worktrees/s1/download?path=missing').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('not_found');
    expect((err as InstanceType<typeof ApiError>).status).toBe(404);
  });

  it('on a non-OK response with an unparseable body, falls back to a generic ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 500 })));
    const { apiFetchRaw, ApiError } = await import('../src/lib/api');

    const err = await apiFetchRaw('GET', '/api/worktrees/s1/download?path=a').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe('unknown');
  });

  it('returns the raw Response on success without consuming the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('file bytes', { status: 200 })));
    const { apiFetchRaw } = await import('../src/lib/api');

    const res = await apiFetchRaw('GET', '/api/worktrees/s1/download?path=a');
    expect(await res.text()).toBe('file bytes');
  });
});
