import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, huddleDocumentSchema, huddleMcpTools } from '@puddle/shared';
import { PuddlangClient } from '../../src/puddlang/client.js';
import type { ConnectionAuthority } from '../../src/lib/auth/connection-authority.js';
import { parseHuddleCommand, runHuddleCommand } from '../../src/huddle/commands.js';
import { serveMcp } from '../../src/puddlang/mcp.js';

afterEach(() => vi.unstubAllGlobals());
const location = { project_id: '1234567890', worktree: '/host/project space?x=&y/#branch' };
const target = { ...location, huddle_id: 'a'.repeat(32) };
const document = huddleDocumentSchema.parse({
  digest: 'b'.repeat(64),
  definition: { format: 1, id: target.huddle_id, name: 'Fixture', nodes: [], edges: [] },
  components: {},
  diagnostics: [],
});
function client(protocol: { major: number; minor: number } | undefined = PROTOCOL_VERSION) {
  return new PuddlangClient(
    () => 23456,
    {
      credential: () => 'fixture-authority',
    } as ConnectionAuthority,
    'abcdef1234',
    protocol,
  );
}

it('routes source operations through the selected profile with escaped host worktree and no mutation', async () => {
  const fetch = vi.fn(async () => Response.json(document));
  vi.stubGlobal('fetch', fetch);
  const c = client();
  expect(await c.huddles.inspect(target)).toEqual(document);
  expect(await c.huddles.validate(target)).toEqual({
    valid: true,
    digest: document.digest,
    diagnostics: [],
  });
  for (const [url, request] of fetch.mock.calls as unknown as [string, RequestInit][]) {
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/api/huddle/abcdef1234/definitions/${target.huddle_id}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual(location);
    expect(request).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer fixture-authority' },
    });
    expect(request.body).toBeUndefined();
  }
  fetch.mockResolvedValueOnce(Response.json([]));
  expect(await c.huddles.list(location)).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('prints graph diagnostics and exits unsuccessfully without evaluating or fixing the graph', async () => {
  const diagnostics = [
    {
      severity: 'error',
      code: 'edge_node_missing',
      edge: 'broken',
      path: '/edges/0/from',
      message: 'Node is missing',
    },
  ];
  const fetch = vi.fn(async () => Response.json({ ...document, diagnostics }));
  vi.stubGlobal('fetch', fetch);
  const command = parseHuddleCommand(['validate', target.huddle_id], {
    project: location.project_id,
    worktree: location.worktree,
  });
  const print = vi.fn();
  expect(await runHuddleCommand(client().huddles, command, print)).toBe(1);
  expect(print).toHaveBeenCalledExactlyOnceWith({
    valid: false,
    digest: document.digest,
    diagnostics,
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it('accepts warnings but refuses malformed responses and does not retry a failed read', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ...document,
        diagnostics: [
          {
            severity: 'warning',
            code: 'layout_node_missing',
            path: '/layout',
            message: 'Unused position',
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ valid: true }))
    .mockRejectedValueOnce(new Error('connection closed'));
  vi.stubGlobal('fetch', fetch);
  const c = client();
  expect(await runHuddleCommand(c.huddles, { action: 'validate', input: target }, () => {})).toBe(
    0,
  );
  await expect(c.huddles.inspect(target)).rejects.toThrow();
  await expect(c.huddles.list(location)).rejects.toThrow('connection closed');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  [['list'], { project: location.project_id }],
  [['validate', target.huddle_id], { project: location.project_id, worktree: '.' }],
  [['validate', '../escape'], { project: location.project_id, worktree: '/host' }],
  [['list', 'extra'], { project: location.project_id, worktree: '/host' }],
  [['start', target.huddle_id], { project: location.project_id, worktree: '/host' }],
])('rejects incomplete/implicit scope and unsupported commands (%j)', (args, options) => {
  expect(() => parseHuddleCommand(args, options)).toThrow();
});

it('rejects unsupported peers and unexpected target fields before HTTP', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const protocol of [
    { major: 27, minor: 1 },
    { major: 29, minor: 0 },
  ])
    await expect(client(protocol).huddles.inspect(target)).rejects.toThrow('compatible daemon');
  await expect(
    client().huddles.inspect({ ...target, host_id: 'other' } as typeof target),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it('advertises strict read-only MCP tools and keeps graph diagnostics distinct from malformed calls', async () => {
  const fetch = vi.fn(async () => Response.json(document));
  vi.stubGlobal('fetch', fetch);
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<{
    id: number;
    result: { tools?: typeof huddleMcpTools; isError?: boolean; content?: Array<{ text: string }> };
  }> = [];
  output.on('data', (bytes) => replies.push(JSON.parse(String(bytes))));
  const server = serveMcp(client(), input, output);
  for (const message of [
    { id: 1, method: 'initialize' },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'huddle_validate', arguments: target } },
    {
      id: 4,
      method: 'tools/call',
      params: { name: 'huddle_inspect', arguments: { ...target, activate: true } },
    },
    {
      id: 5,
      method: 'tools/call',
      params: { name: 'huddle_list', arguments: { project_id: location.project_id } },
    },
  ])
    input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  input.end();
  await server;
  expect(replies.find((r) => r.id === 2)?.result.tools).toEqual(
    expect.arrayContaining(huddleMcpTools),
  );
  for (const tool of huddleMcpTools) {
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }
  expect(JSON.parse(replies.find((r) => r.id === 3)!.result.content![0]!.text)).toEqual({
    valid: true,
    digest: document.digest,
    diagnostics: [],
  });
  for (const id of [4, 5]) expect(replies.find((r) => r.id === id)?.result.isError).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

it('does not advertise or dispatch huddle tools on unsupported MCP connections', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (bytes) => {
    text += String(bytes);
  });
  const server = serveMcp(client({ major: 27, minor: 1 }), input, output);
  input.end(
    [
      { id: 1, method: 'initialize' },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'huddle_validate', arguments: target } },
    ]
      .map((message) => JSON.stringify({ jsonrpc: '2.0', ...message }))
      .join('\n') + '\n',
  );
  await server;
  const replies = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    replies
      .find((r) => r.id === 2)
      .result.tools.some((t: { name: string }) => t.name.startsWith('huddle_')),
  ).toBe(false);
  expect(replies.find((r) => r.id === 3).result.isError).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
