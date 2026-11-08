import { QueryClient } from '@tanstack/react-query';
import type { UntitledFileResponse } from '@puddle/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteUntitled,
  untitledQueryKey,
  updateCachedUntitled,
} from '../../../src/lib/queries/untitled-queries';

afterEach(() => vi.unstubAllGlobals());

describe('deleteUntitled', () => {
  const respond = (status: number, code: string) => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { code, message: 'Draft unavailable' } }, { status }),
      ),
    );
  };
  it('accepts confirmed absence after explicit discard', async () => {
    respond(404, 'not_found');
    await expect(deleteUntitled('0000000001', 'untitled-1.md')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      '/api/profiles/0000000001/untitled/untitled-1.md',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
  it.each([
    [403, 'forbidden'],
    [404, 'unknown'],
    [500, 'internal_error'],
  ])('retains failures for %s/%s', async (status, code) => {
    respond(status as number, code as string);
    await expect(deleteUntitled('0000000001', 'untitled-1.md')).rejects.toMatchObject({
      status,
      code,
    });
  });
  it('does not turn lost replies into deletion success', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Connection lost');
      }),
    );
    await expect(deleteUntitled('0000000001', 'untitled-1.md')).rejects.toThrow('Connection lost');
  });
});

describe('updateCachedUntitled', () => {
  it('makes the latest Monaco edit the source for a tab remount', () => {
    const queryClient = new QueryClient();
    const key = untitledQueryKey('profile-1', 'untitled-1.md');
    queryClient.setQueryData<UntitledFileResponse>(key, {
      name: 'untitled-1.md',
      content: '',
      mtime_ms: 1,
    });

    updateCachedUntitled(queryClient, 'profile-1', 'untitled-1.md', 'kept across tabs');

    expect(queryClient.getQueryData<UntitledFileResponse>(key)).toEqual({
      name: 'untitled-1.md',
      content: 'kept across tabs',
      mtime_ms: 1,
    });
  });

  it('does not fabricate a loaded response before the GET completes', () => {
    const queryClient = new QueryClient();
    const key = untitledQueryKey('profile-1', 'untitled-1.md');

    updateCachedUntitled(queryClient, 'profile-1', 'untitled-1.md', 'draft');

    expect(queryClient.getQueryData(key)).toBeUndefined();
  });
});
