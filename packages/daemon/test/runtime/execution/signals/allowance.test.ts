import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeSignals } from '../../../../src/runtime/execution/signals.js';
import { RuntimeBufferBudget } from '../../../../src/runtime/resources/budget.js';
import { RUNTIME_SIGNAL_WORK_BYTES } from '../../../../src/runtime/execution/signals/body.js';

const endpoints: RuntimeSignals[] = [];
afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
const nonce = 'runtime-signal-allowance-fixture';
const request = (url: string) =>
  fetch(url, {
    method: 'POST',
    body: JSON.stringify({ nonce, state: 'working' }),
  });

it('charges before body reading and retains capacity through asynchronous signal handling', async () => {
  const allowance = new RuntimeBufferBudget({ bytes: RUNTIME_SIGNAL_WORK_BYTES, count: 1 });
  let release!: () => void;
  const gate = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  const receive = vi.fn(() => gate);
  const endpoint = new RuntimeSignals(nonce, receive, allowance);
  endpoints.push(endpoint);
  const url = await endpoint.listen();
  const first = request(url);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
  expect(allowance.usedBytes).toBe(RUNTIME_SIGNAL_WORK_BYTES);
  const refused = await request(url);
  expect(refused.status).toBe(503);
  await refused.arrayBuffer();
  expect(receive).toHaveBeenCalledOnce();
  release();
  const accepted = await first;
  expect(accepted.status).toBe(204);
  await accepted.arrayBuffer();
  expect(allowance.usedBytes).toBe(0);
  const next = await request(url);
  expect(next.status).toBe(204);
  await next.arrayBuffer();
});

it('releases admitted work after invalid input without invoking lifecycle delivery', async () => {
  const allowance = new RuntimeBufferBudget({ bytes: RUNTIME_SIGNAL_WORK_BYTES, count: 1 });
  const receive = vi.fn(() => true);
  const endpoint = new RuntimeSignals(nonce, receive, allowance);
  endpoints.push(endpoint);
  const url = await endpoint.listen();
  const response = await fetch(url, { method: 'POST', body: '{"nested":{}}' });
  expect(response.status).toBe(400);
  await response.arrayBuffer();
  expect(receive).not.toHaveBeenCalled();
  expect(allowance.usedBytes).toBe(0);
});

it('returns the existing 413 for an oversized body and releases its reservation', async () => {
  const allowance = new RuntimeBufferBudget({ bytes: RUNTIME_SIGNAL_WORK_BYTES, count: 1 });
  const receive = vi.fn(() => true);
  const endpoint = new RuntimeSignals(nonce, receive, allowance);
  endpoints.push(endpoint);
  const url = await endpoint.listen();
  const response = await fetch(url, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024 + 1) });
  expect(response.status).toBe(413);
  await response.arrayBuffer();
  expect(receive).not.toHaveBeenCalled();
  expect(allowance.usedBytes).toBe(0);
});
