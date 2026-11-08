import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HuddleExecutionClient } from '../../src/huddle/execution/client.js';
import { executionTools } from '../../src/huddle/execution/mcp.js';
import { parseHuddleCommand } from '../../src/huddle/commands.js';
it('gates recorded revision tools and verifies exact responses without fallback', async () => {
  const owner = { runtimeId: randomUUID(), incarnation: randomUUID() };
  const request = { owner, revision: 'a'.repeat(64) };
  const session_id = randomUUID();
  const reply = {
    source: 'retained-revision',
    observed_at: new Date().toISOString(),
    owner,
    revision: request.revision,
    activation: null,
    saved: null,
    entries: [],
  };
  const send = vi.fn(async () => reply);
  const old = new HuddleExecutionClient(send, { major: 28, minor: 12 });
  expect(executionTools(old).some((tool) => tool.name === 'huddle_retained_revision')).toBe(false);
  await expect(old.execute({ action: 'retained-revision', session_id, request })).rejects.toThrow(
    '28.13',
  );
  expect(send).not.toHaveBeenCalled();
  const client = new HuddleExecutionClient(send, { major: 28, minor: 13 });
  expect(
    executionTools(client).find((tool) => tool.name === 'huddle_retained_revision')?.annotations
      .readOnlyHint,
  ).toBe(true);
  expect(
    parseHuddleCommand(['retained-revision', session_id], { request: JSON.stringify(request) }),
  ).toMatchObject({ command: { action: 'retained-revision', request } });
  await expect(
    client.execute({ action: 'retained-revision', session_id, request }),
  ).resolves.toEqual(reply);
  expect(send).toHaveBeenCalledExactlyOnceWith(
    `/sessions/${session_id}/revision/retained`,
    request,
  );
  send.mockResolvedValueOnce({ ...reply, revision: 'b'.repeat(64) });
  await expect(
    client.execute({ action: 'retained-revision', session_id, request }),
  ).rejects.toThrow('revision');
  expect(send).toHaveBeenCalledTimes(2);
});
