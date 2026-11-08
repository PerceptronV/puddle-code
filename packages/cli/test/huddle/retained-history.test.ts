import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HuddleExecutionClient } from '../../src/huddle/execution/client.js';
import { executionTools } from '../../src/huddle/execution/mcp.js';
import { parseHuddleCommand } from '../../src/huddle/commands.js';

const session_id = randomUUID();
const request = {
  owner: { runtimeId: randomUUID(), incarnation: randomUUID() },
  collection: 'executions' as const,
  after: 0,
};
it('gates retained tools and forwards exact reviewed identity without live fallback', async () => {
  const send = vi.fn(async () => ({
    source: 'retained-ledger',
    observed_at: new Date().toISOString(),
    history: { owner: request.owner, collection: 'executions', records: [], next: 0 },
  }));
  const old = new HuddleExecutionClient(send, { major: 28, minor: 11 });
  expect(executionTools(old).some((tool) => tool.name === 'huddle_retained_history')).toBe(false);
  await expect(old.execute({ action: 'retained-history', session_id, request })).rejects.toThrow(
    '28.12',
  );
  expect(send).not.toHaveBeenCalled();
  const client = new HuddleExecutionClient(send, { major: 28, minor: 12 });
  expect(
    executionTools(client).find((tool) => tool.name === 'huddle_retained_history')?.annotations
      .readOnlyHint,
  ).toBe(true);
  await client.execute({ action: 'retained-history', session_id, request });
  expect(send).toHaveBeenCalledExactlyOnceWith(`/sessions/${session_id}/history/retained`, request);
  send.mockRejectedValueOnce(new Error('missing ledger'));
  await expect(client.execute({ action: 'retained-history', session_id, request })).rejects.toThrow(
    'missing ledger',
  );
  expect(send).toHaveBeenCalledTimes(2);
});
it('parses recorded owner and retained page commands with explicit JSON', () => {
  expect(parseHuddleCommand(['history-owners', session_id], { request: '{}' })).toMatchObject({
    action: 'execution',
    command: { action: 'history-owners', request: {} },
  });
  expect(
    parseHuddleCommand(['retained-history', session_id], { request: JSON.stringify(request) }),
  ).toMatchObject({ command: { action: 'retained-history', request } });
});
