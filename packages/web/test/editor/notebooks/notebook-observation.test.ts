import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { NotebookExecutionResponse } from '@puddle/shared';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/transport/api', () => ({ api: request }));
import {
  notebookObservation,
  notebookObservationInterval,
} from '../../../src/features/editor/notebooks/notebook-observation';
import { notebookObservationSupported } from '../../../src/lib/transport/protocol-support';

const source = { session: '00000000-0000-0000-0000-000000000000', path: 'example.ipynb' };
const clients: QueryClient[] = [];
function fixture(revisions = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const observer = notebookObservation(client, source, revisions);
  return {
    client,
    observer,
    fetch: () => client.fetchQuery({ queryKey: observer.queryKey, queryFn: observer.queryFn }),
  };
}
const snapshot = (
  id = '00000000-0000-4000-8000-000000000001',
  revision = 0,
): NotebookExecutionResponse => ({ execution: { id, revision, state: 'running', cells: [] } });
afterEach(() => {
  request.mockReset();
  for (const client of clients.splice(0)) client.clear();
});

it('keeps a full cached snapshot through unchanged observations and refreshes on invalidation/reconnect', async () => {
  const { client, observer, fetch } = fixture();
  request.mockResolvedValueOnce(snapshot());
  const original = await fetch();
  expect(request.mock.calls[0]?.[2]).toEqual({ source });
  request.mockResolvedValueOnce({ unchanged: true });
  expect(await fetch()).toBe(original);
  expect(request.mock.calls[1]?.[2]).toEqual({
    source,
    known: { id: original.execution!.id, revision: 0 },
  });
  observer.reset();
  request.mockResolvedValueOnce(snapshot());
  await fetch();
  expect(request.mock.calls[2]?.[2]).toEqual({ source });
  await client.invalidateQueries({ queryKey: observer.queryKey, refetchType: 'none' });
  request.mockResolvedValueOnce(snapshot());
  await fetch();
  expect(request.mock.calls[3]?.[2]).toEqual({ source });
});

it('discovers runs after an idle null result and preserves full replies from older hosts', async () => {
  const current = fixture();
  request.mockResolvedValueOnce({ execution: null });
  await current.fetch();
  request.mockResolvedValueOnce({ unchanged: true });
  expect(await current.fetch()).toEqual({ execution: null });
  expect(request.mock.calls[1]?.[2]).toEqual({ source, known: null });
  request.mockResolvedValueOnce(snapshot());
  expect((await current.fetch()).execution?.id).toBe(snapshot().execution!.id);
  const old = fixture(false);
  request.mockResolvedValue(snapshot());
  await old.fetch();
  await old.fetch();
  expect(request.mock.calls.at(-1)?.[2]).toEqual({ source });
  expect(notebookObservationSupported({ major: 26, minor: 2 })).toBe(false);
  expect(notebookObservationSupported({ major: 26, minor: 3 })).toBe(true);
  expect(notebookObservationSupported({ major: 27, minor: 0 })).toBe(true);
});

it('rejects unsolicited unchanged replies and retries observation errors with a full read', async () => {
  const { fetch } = fixture();
  request.mockResolvedValueOnce({ unchanged: true });
  await expect(fetch()).rejects.toThrow('no matching snapshot');
  request.mockResolvedValueOnce(snapshot());
  await fetch();
  expect(request.mock.calls.at(-1)?.[2]).toEqual({ source });
  request.mockRejectedValueOnce(new Error('disconnected'));
  await expect(fetch()).rejects.toThrow('disconnected');
  request.mockResolvedValueOnce(snapshot());
  await fetch();
  expect(request.mock.calls.at(-1)?.[2]).toEqual({ source });
});

it('cancels a late poll before a successful explicit run replaces the cache', async () => {
  const { client, observer, fetch } = fixture();
  request.mockResolvedValueOnce(snapshot());
  await fetch();
  let finish!: (value: NotebookExecutionResponse) => void;
  request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = fetch();
  await client.cancelQueries({ queryKey: observer.queryKey });
  const newRun = snapshot('00000000-0000-4000-8000-000000000002');
  client.setQueryData(observer.queryKey, newRun);
  finish(snapshot());
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((request.mock.calls.at(-1)?.[3] as AbortSignal).aborted).toBe(true);
  expect(client.getQueryData(observer.queryKey)).toEqual(newRun);
});

it('keeps discovery polling idle notebooks while giving running notebooks a short interval', () => {
  expect(notebookObservationInterval(snapshot())).toBe(250);
  expect(notebookObservationInterval({ execution: null })).toBe(5000);
  expect(
    notebookObservationInterval({ execution: { ...snapshot().execution!, state: 'succeeded' } }),
  ).toBe(5000);
});

it('slows unfocused observation without stopping discovery', async () => {
  vi.resetModules();
  const window = new EventTarget();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'visible' });
  try {
    const { notebookObservationInterval: interval } =
      await import('../../../src/features/editor/notebooks/notebook-observation');
    expect(interval(snapshot())).toBe(3000);
    expect(interval({ execution: null })).toBe(60_000);
    window.dispatchEvent(new Event('focus'));
    expect(interval(snapshot())).toBe(250);
    expect(interval({ execution: null })).toBe(5000);
  } finally {
    vi.unstubAllGlobals();
  }
});
