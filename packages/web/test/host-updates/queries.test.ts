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
  vi.mocked(browserTransport).mockReturnValue(null);
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
    expect(api).toHaveBeenCalledExactlyOnceWith(
      'GET',
      '/cockpit/updates?components=1',
      undefined,
      expect.any(AbortSignal),
    );
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

  it('never sends host inventory or mutations without an admitted maintenance capability', async () => {
    vi.mocked(browserTransport).mockReturnValue({ scope: 'remote' } as NonNullable<
      ReturnType<typeof browserTransport>
    >);
    try {
      const queryClient = client();
      expect(hostUpdateQuery().enabled).toBe(false);
      await expect(queryClient.fetchQuery(hostUpdateQuery())).rejects.toThrow('host-approved');
      const mutation = queryClient
        .getMutationCache()
        .build(queryClient, hostUpdateMutation(queryClient));
      await expect(
        mutation.execute({
          action: 'prepare',
          targets: [{ component: 'daemon', version: '0.4.1' }],
        }),
      ).rejects.toThrow('host-approved');
      expect(api).not.toHaveBeenCalled();
    } finally {
      vi.mocked(browserTransport).mockReturnValue(null);
    }
  });

  it('routes authorised relay updates through the private bridge and scopes caches by host', async () => {
    const queryClient = client();
    vi.mocked(browserTransport).mockReturnValue({
      scope: 'host-a',
      generation: 'first',
    } as NonNullable<ReturnType<typeof browserTransport>>);
    const first = hostUpdateQuery(true);
    vi.mocked(api).mockImplementation(async (_method, path) =>
      path === '/api/version'
        ? { version: '0.4.8', protocol: { major: 26, minor: 1 } }
        : statusFixture(),
    );
    await queryClient.fetchQuery(first);
    expect(api).toHaveBeenCalledWith(
      'GET',
      '/api/host/updates',
      undefined,
      expect.any(AbortSignal),
    );
    const review = reviewFixture(true);
    vi.mocked(api).mockResolvedValue(review);
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, hostUpdateMutation(queryClient, true));
    const request = {
      action: 'apply' as const,
      reference: { id: review.operation!.id, revision: 3 },
      fingerprint: 'a'.repeat(64),
      interruption_approval: 'b'.repeat(64),
    };
    await mutation.execute(request);
    expect(api).toHaveBeenCalledWith('POST', '/api/host/updates', request, undefined);
    vi.mocked(browserTransport).mockReturnValue({
      scope: 'host-b',
      generation: 'second',
    } as NonNullable<ReturnType<typeof browserTransport>>);
    expect(hostUpdateQuery(true).queryKey).not.toEqual(first.queryKey);
    expect(queryClient.getQueryData(hostUpdateQuery(true).queryKey)).toBeUndefined();
  });

  it('rejects relay offline continuation and stale host/generation writes before sending', async () => {
    const remote = { scope: 'host-a', generation: 'first' } as NonNullable<
      ReturnType<typeof browserTransport>
    >;
    vi.mocked(browserTransport).mockReturnValue(remote);
    const queryClient = client();
    const options = hostUpdateMutation(queryClient, true);
    const reference = { id: reviewFixture().operation!.id, revision: 3 };
    await expect(options.mutationFn({ action: 'continue-offline', reference })).rejects.toThrow();
    Object.assign(remote, { generation: 'replacement' });
    await expect(
      options.mutationFn({ action: 'recover', reference, strategy: 'continue' }),
    ).rejects.toThrow('connection changed');
    expect(api).not.toHaveBeenCalled();
  });

  it('discards a delayed relay reply after replacement admission and does not retry', async () => {
    const remote = { scope: 'host-a', generation: 'first' } as NonNullable<
      ReturnType<typeof browserTransport>
    >;
    vi.mocked(browserTransport).mockReturnValue(remote);
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const queryClient = client();
    const options = hostUpdateMutation(queryClient, true);
    const attempt = options.mutationFn({
      action: 'inspect',
      reference: { id: reviewFixture().operation!.id, revision: 3 },
    });
    const rejected = expect(attempt).rejects.toThrow('connection changed');
    Object.assign(remote, { generation: 'replacement' });
    resolve(reviewFixture());
    await rejected;
    expect(api).toHaveBeenCalledTimes(1);
  });
});
