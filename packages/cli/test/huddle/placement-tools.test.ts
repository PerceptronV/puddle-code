import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, huddleToolSessionSchema } from '@puddle/shared';
import { PuddlangClient } from '../../src/puddlang/client.js';
import type { ConnectionAuthority } from '../../src/lib/auth/connection-authority.js';
import { parseHuddleCommand, runHuddleCommand } from '../../src/huddle/commands.js';
import { HuddleClient } from '../../src/huddle/client.js';
import { placementTools, callHuddlePlacementTool } from '../../src/huddle/placement/mcp.js';
import { serveMcp } from '../../src/puddlang/mcp.js';

afterEach(() => vi.unstubAllGlobals());
const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const scope = { session_id: id, unresolved: false, owner: null };
const session = huddleToolSessionSchema.parse({
  id,
  project_id: '1234567890',
  account_id: null,
  worktree_path: '/explicit/worktree',
  base_branch: 'main',
  branch: 'main',
  separate_branch: false,
  kind: 'huddle',
  huddle_id: 'a'.repeat(32),
  agent_type: null,
  agent_session_ref: null,
  title: 'Fixture',
  status: 'exited',
  skip_permissions: false,
  created_at: '2026-11-08T00:00:00Z',
  updated_at: '2026-11-08T00:00:00Z',
  last_activity_at: null,
});
function connection(protocol: { major: number; minor: number } = PROTOCOL_VERSION) {
  return new PuddlangClient(
    () => 23456,
    { credential: () => 'fixture-authority' } as ConnectionAuthority,
    'abcdef1234',
    protocol,
  );
}

it.each(['session', 'archive', 'unarchive'] as const)(
  'checks selected profile scope before one ordinary session %s request',
  async (action) => {
    const result = { ...session, status: action === 'archive' ? 'archived' : 'exited' };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(scope))
      .mockResolvedValueOnce(Response.json(result));
    vi.stubGlobal('fetch', fetch);
    const print = vi.fn();
    expect(
      await runHuddleCommand(connection().huddles, parseHuddleCommand([action, id], {}), print),
    ).toBe(0);
    expect(print).toHaveBeenCalledExactlyOnceWith(result);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `http://127.0.0.1:23456/api/huddle/abcdef1234/sessions/${id}/runtime`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bearer fixture-authority' }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `http://127.0.0.1:23456/api/sessions/${id}${action === 'session' ? '' : '/' + action}`,
      expect.objectContaining({
        method: action === 'session' ? 'GET' : 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer fixture-authority' }),
        ...(action === 'session' ? {} : { body: '{}' }),
      }),
    );
  },
);

it.each(['profile_scope', 'not_huddle', 'upstream_expired', 'huddle_unavailable'])(
  'does not dispatch a placement mutation when scoped inspection rejects %s',
  async (code) => {
    const fetch = vi.fn(async () => Response.json({ error: { code } }, { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      connection().huddles.placement.execute({ action: 'archive', session_id: id }),
    ).rejects.toThrow(code);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([{}, { ...scope, session_id: otherId }])(
  'rejects invalid scope evidence before mutation',
  async (value) => {
    const mutate = vi.fn();
    const c = new HuddleClient(async () => value, PROTOCOL_VERSION, mutate);
    await expect(c.placement.execute({ action: 'unarchive', session_id: id })).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  },
);

it.each(['archive', 'unarchive'] as const)(
  'does not retry or re-inspect after a lost %s reply',
  async (action) => {
    const inspect = vi.fn(async () => scope);
    const mutate = vi.fn(async () => {
      throw new Error('lost accepted reply');
    });
    const c = new HuddleClient(inspect, PROTOCOL_VERSION, mutate);
    await expect(c.placement.execute({ action, session_id: id })).rejects.toThrow(
      /Inspect session.*Do not retry automatically/s,
    );
    expect(inspect).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledExactlyOnceWith(`/${id}/${action}`, {});
  },
);

it.each([
  { ...session, kind: 'terminal' },
  { ...session, id: otherId, status: 'archived' },
  { ...session, status: 'running' },
  { ...session, huddle_id: undefined, status: 'archived' },
])('does not claim archive success for malformed or mismatched replies', async (reply) => {
  const mutate = vi.fn(async () => reply);
  const c = new HuddleClient(async () => scope, PROTOCOL_VERSION, mutate);
  await expect(c.placement.execute({ action: 'archive', session_id: id })).rejects.toThrow(
    'outcome may be uncertain',
  );
  expect(mutate).toHaveBeenCalledOnce();
});

it('rejects an unarchive reply that claims a running huddle', async () => {
  const c = new HuddleClient(
    async () => scope,
    PROTOCOL_VERSION,
    async () => ({ ...session, status: 'running' }),
  );
  await expect(c.placement.execute({ action: 'unarchive', session_id: id })).rejects.toThrow(
    'unarchive was not confirmed',
  );
});

it('gates placement tools without weakening source/runtime tool availability', async () => {
  const request = vi.fn();
  for (const c of [
    new HuddleClient(request, PROTOCOL_VERSION),
    new HuddleClient(request, { major: 28, minor: 1 }, request),
  ]) {
    expect(placementTools(c.placement)).toEqual([]);
    await expect(c.placement.execute({ action: 'archive', session_id: id })).rejects.toThrow(
      '28.2',
    );
  }
  expect(request).not.toHaveBeenCalled();
  expect(placementTools(connection({ major: 28, minor: 2 }).huddles.placement)).toHaveLength(3);
});

it.each(['session', 'archive', 'unarchive'])('requires only a placement UUID for %s', (action) => {
  for (const args of [[action], [action, 'a'.repeat(32)], [action, id, 'extra']])
    expect(() => parseHuddleCommand(args, {})).toThrow();
  for (const options of [
    { request: '{}' },
    { worktree: '/other' },
    { project: '1234567890' },
    { name: 'ignored' },
  ])
    expect(() => parseHuddleCommand([action, id], options)).toThrow();
});

it('rejects MCP action overrides before any request', async () => {
  const request = vi.fn();
  const c = new HuddleClient(request, PROTOCOL_VERSION, request);
  await expect(
    callHuddlePlacementTool(c.placement, 'huddle_session', { session_id: id, action: 'archive' }),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it('advertises and dispatches placement tools through stdio MCP', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(scope))
    .mockResolvedValueOnce(Response.json({ ...session, status: 'archived' }));
  vi.stubGlobal('fetch', fetch);
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<{
    id: number;
    result: {
      tools?: Array<{
        name: string;
        action?: string;
        annotations: { readOnlyHint: boolean; idempotentHint: boolean };
      }>;
      content?: Array<{ text: string }>;
      isError?: boolean;
    };
  }> = [];
  output.on('data', (bytes) => replies.push(JSON.parse(String(bytes))));
  const done = serveMcp(connection(), input, output);
  for (const message of [
    { id: 1, method: 'initialize' },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    {
      id: 3,
      method: 'tools/call',
      params: { name: 'huddle_archive', arguments: { session_id: id } },
    },
  ])
    input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  input.end();
  await done;
  const tools = replies.find((reply) => reply.id === 2)!.result.tools!;
  expect(tools.find((tool) => tool.name === 'huddle_archive')?.annotations).toMatchObject({
    readOnlyHint: false,
    idempotentHint: false,
  });
  expect(tools.find((tool) => tool.name === 'huddle_unarchive')?.annotations).toMatchObject({
    readOnlyHint: false,
    idempotentHint: false,
  });
  expect(tools.find((tool) => tool.name === 'huddle_session')?.annotations.readOnlyHint).toBe(true);
  expect(tools.some((tool) => 'action' in tool)).toBe(false);
  const result = replies.find((reply) => reply.id === 3)!.result;
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.content![0]!.text)).toMatchObject({ id, status: 'archived' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
