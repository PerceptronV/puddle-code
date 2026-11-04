import { QueryClient, QueryObserver, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../src/lib/transport/api';
import { browserTransport } from '../../src/lib/transport/browser-transport';
import { hostUpdateMutation, hostUpdateQuery } from '../../src/features/host-updates/queries';
import { reviewFixture, statusFixture } from './fixtures';

vi.mock('../../src/lib/transport/api', () => ({ api: vi.fn(), ApiError: class extends Error {} }));
vi.mock('../../src/lib/transport/browser-transport', () => ({
  browserTransport: vi.fn(() => null),
}));
vi.mock('../../src/lib/transport/ws', () => ({ wsManager: {} }));
const clients: QueryClient[] = [];
function client() {
  const result = new QueryClient({ defaultOptions: { mutations: { retry: 3, retryDelay: 0 } } });
  result.mount();
  clients.push(result);
  return result;
}
afterEach(() => {
  clients.splice(0).forEach((item) => {
    item.unmount();
    item.clear();
  });
  vi.clearAllMocks();
  onlineManager.setOnline(true);
});

describe('cockpit host update requests', () => {
  it('coalesces concurrent window reads and validates the shared response', async () => {
    const queryClient = client();
    const status = statusFixture();
    vi.mocked(api).mockResolvedValue(status);
    const [first, second] = await Promise.all([
      queryClient.fetchQuery(hostUpdateQuery()),
      queryClient.fetchQuery(hostUpdateQuery()),
    ]);
    expect(first).toEqual(status);
    expect(second).toEqual(status);
    expect(api).toHaveBeenCalledExactlyOnceWith('GET', '/cockpit/updates');
    vi.mocked(api).mockResolvedValue({ availability: 'ready', credentials: 'unexpected' });
    await expect(queryClient.fetchQuery({ ...hostUpdateQuery(), staleTime: 0 })).rejects.toThrow();
  });

  it('observes a lost apply reply without retrying, including offline browser state', async () => {
    const queryClient = client();
    const initial = statusFixture();
    const review = reviewFixture();
    initial.result = review;
    queryClient.setQueryData(hostUpdateQuery().queryKey, initial);
    const observer = new QueryObserver(queryClient, hostUpdateQuery());
    const unsubscribe = observer.subscribe(() => {});
    vi.mocked(api).mockImplementation(async (method) => {
      if (method === 'POST') throw new Error('lost reply after acceptance');
      return {
        ...initial,
        result: {
          ok: true,
          operation: { ...review.operation!, phase: 'applying', dispatched: true },
        },
      };
    });
    onlineManager.setOnline(false);
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, hostUpdateMutation(queryClient));
    const attempt = mutation.execute({
      action: 'apply',
      reference: { id: review.operation!.id, revision: 3 },
      fingerprint: 'a'.repeat(64),
    });
    const rejected = expect(attempt).rejects.toThrow('lost reply');
    // Reads may wait for connectivity, writes must fail now rather than queue for later.
    await vi.waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([method]) => method === 'POST')).toBe(true),
    );
    onlineManager.setOnline(true);
    await rejected;
    expect(vi.mocked(api).mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data?.result?.operation?.phase).toBe('applying'),
    );
    unsubscribe();
  });

  it('keeps exact rejection replies for the caller while refreshing authoritative status', async () => {
    const queryClient = client();
    const status = statusFixture();
    queryClient.setQueryData(hostUpdateQuery().queryKey, status);
    const rejected = { ok: false, code: 'conflict', operation: reviewFixture().operation };
    vi.mocked(api).mockResolvedValue(rejected);
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, hostUpdateMutation(queryClient));
    expect(
      await mutation.execute({
        action: 'inspect',
        reference: { id: rejected.operation!.id, revision: 2 },
      }),
    ).toEqual(rejected);
    expect(queryClient.getQueryData(hostUpdateQuery().queryKey)?.result).toEqual(rejected);
  });

  it('never sends host inventory or mutations over a relay transport', async () => {
    vi.mocked(browserTransport).mockReturnValue({ scope: 'remote' } as NonNullable<
      ReturnType<typeof browserTransport>
    >);
    try {
      const queryClient = client();
      expect(hostUpdateQuery().enabled).toBe(false);
      await expect(queryClient.fetchQuery(hostUpdateQuery())).rejects.toThrow('local or SSH');
      const mutation = queryClient
        .getMutationCache()
        .build(queryClient, hostUpdateMutation(queryClient));
      await expect(
        mutation.execute({
          action: 'prepare',
          targets: [{ component: 'daemon', version: '0.4.1' }],
        }),
      ).rejects.toThrow('local or SSH');
      expect(api).not.toHaveBeenCalled();
    } finally {
      vi.mocked(browserTransport).mockReturnValue(null);
    }
  });
});
