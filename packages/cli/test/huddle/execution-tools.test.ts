import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, huddleToolExecutionCommandSchema, HUDDLE_LIMITS } from '@puddle/shared';
import { PuddlangClient } from '../../src/puddlang/client.js';
import type { ConnectionAuthority } from '../../src/lib/auth/connection-authority.js';
import { HuddleClient } from '../../src/huddle/client.js';
import { parseHuddleCommand, runHuddleCommand } from '../../src/huddle/commands.js';
import { executionTools } from '../../src/huddle/execution/mcp.js';
import { serveMcp } from '../../src/puddlang/mcp.js';

afterEach(() => vi.unstubAllGlobals());
const session = '00000000-0000-4000-8000-000000000001';
const target = {
  runtimeId: '00000000-0000-4000-8000-000000000002',
  incarnation: '00000000-0000-4000-8000-000000000003',
  generation: 7,
  activationId: '00000000-0000-4000-8000-000000000004',
};
const owner = { runtimeId: target.runtimeId, incarnation: target.incarnation };
const event = '00000000-0000-4000-8000-000000000005';
const digest = 'a'.repeat(64);
const inspection = {
  session_id: session,
  unresolved: false,
  owner: {
    connected: true,
    target,
    build: 'fixture',
    lifetime: 'service',
    lifecycle: 'armed',
    executing: false,
    stopping: false,
    failure: null,
  },
};
const bodies = {
  start: { expected_digest: digest, variables: { tree: '/chosen/worktree' } },
  apply: { target, expected_digest: digest, variables: { tree: '/chosen/worktree' } },
  run: { target, node: 'run', event_id: event, data: { prompt: 'selected input' } },
  interrupt: { target },
  resume: { target },
  stop: { target },
  history: { owner, collection: 'executions', after: 9 },
  'observe-readout': { target, operation_id: event },
};
it('retains bounded JSON admission despite the MCP presentation schema', async () => {
  const request = vi.fn();
  const client = new HuddleClient(request, PROTOCOL_VERSION);
  await expect(
    client.execution.execute({
      action: 'run',
      session_id: session,
      request: { ...bodies.run, data: 'x'.repeat(HUDDLE_LIMITS.valueBytes + 1) },
    }),
  ).rejects.toThrow('bounded JSON');
  expect(request).not.toHaveBeenCalled();
});
function connection(
  protocol = { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor as number },
) {
  return new PuddlangClient(
    () => 23456,
    { credential: () => 'fixture-authority' } as ConnectionAuthority,
    'abcdef1234',
    protocol,
  );
}

it.each(Object.entries(bodies))(
  'forwards one exact %s request without inspecting or substituting targets',
  async (action, body) => {
    const reply =
      action === 'stop'
        ? { stopped: true }
        : action === 'run'
          ? { executionId: event, duplicate: false }
          : action === 'observe-readout'
            ? { accepted: true, operation_id: event }
            : action === 'history'
              ? { owner, collection: 'executions', records: [], next: 9 }
              : inspection;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(reply));
    vi.stubGlobal('fetch', fetch);
    const command = parseHuddleCommand([action, session], { request: JSON.stringify(body) });
    const print = vi.fn();
    expect(await runHuddleCommand(connection().huddles, command, print)).toBe(0);
    expect(print).toHaveBeenCalledExactlyOnceWith(reply);
    const route =
      action === 'resume' ? 'rearm' : action === 'observe-readout' ? 'readouts/observe' : action;
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:23456/api/huddle/abcdef1234/sessions/${session}/${route}`,
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer fixture-authority', 'content-type': 'application/json' },
      }),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(body);
  },
);

it.each(['start', 'apply', 'run', 'interrupt', 'resume', 'stop', 'observe-readout'] as const)(
  'does not replay or inspect automatically after a lost %s reply',
  async (action) => {
    const request = vi.fn(async () => {
      throw new Error('reply lost after acceptance');
    });
    const client = new HuddleClient(request, PROTOCOL_VERSION);
    await expect(
      client.execution.execute(
        huddleToolExecutionCommandSchema.parse({
          action,
          session_id: session,
          request: bodies[action],
        }),
      ),
    ).rejects.toThrow(/Inspect runtime and history.*Do not retry automatically/s);
    expect(request).toHaveBeenCalledOnce();
  },
);

it('treats a malformed mutation response as uncertain and leaves caller identity untouched', async () => {
  const request = vi.fn(async () => ({ stopped: false }));
  const client = new HuddleClient(request, PROTOCOL_VERSION);
  await expect(
    client.execution.execute({ action: 'stop', session_id: session, request: { target } }),
  ).rejects.toThrow('outcome may be uncertain');
  expect(request).toHaveBeenCalledExactlyOnceWith(`/sessions/${session}/stop`, { target });
  expect(target.generation).toBe(7);
});

it('gates runtime features and opt-in inspection fields independently of source tools', async () => {
  const request = vi.fn(async () => inspection);
  const old = new HuddleClient(request, { major: 28, minor: 1 });
  expect(old.supported).toBe(true);
  expect(executionTools(old.execution)).toEqual([]);
  await expect(old.execution.execute({ action: 'runtime', session_id: session })).rejects.toThrow(
    '28.2',
  );
  expect(request).not.toHaveBeenCalled();
  const basic = new HuddleClient(request, { major: 28, minor: 2 });
  expect(
    executionTools(basic.execution).some((tool) => tool.name === 'huddle_observe_readout'),
  ).toBe(false);
  await basic.execution.execute({ action: 'runtime', session_id: session });
  expect(request).toHaveBeenLastCalledWith(`/sessions/${session}/runtime`);
  await expect(
    basic.execution.execute({
      action: 'history',
      session_id: session,
      request: { owner, collection: 'executions', after: 0, include_readout_observation: true },
    }),
  ).rejects.toThrow('28.6');
  await expect(
    basic.execution.execute({
      action: 'observe-readout',
      session_id: session,
      request: bodies['observe-readout'],
    }),
  ).rejects.toThrow('28.6');
  expect(request).toHaveBeenCalledOnce();
  const current = new HuddleClient(request, PROTOCOL_VERSION);
  await current.execution.execute({ action: 'runtime', session_id: session });
  expect(request).toHaveBeenLastCalledWith(
    `/sessions/${session}/runtime?include_readout_observation=true&include_custom_triggers=true`,
  );
});

it.each([
  ['start', undefined],
  ['start', '{}'],
  ['start', JSON.stringify({ expected_digest: digest })],
  ['apply', JSON.stringify(bodies.start)],
  ['run', JSON.stringify({ target, node: 'run', data: null })],
  ['stop', JSON.stringify({ target: { ...target, generation: undefined } })],
  ['runtime', '{}'],
  ['history', JSON.stringify({ owner, collection: 'invocations', after: 0 })],
])('requires all reviewed %s fields before any connection', (action, request) => {
  expect(() => parseHuddleCommand([action!, session], { request })).toThrow();
});

it('rejects ignored scope/name flags on runtime commands and does not accept a request on source reads', () => {
  expect(() =>
    parseHuddleCommand(['stop', session], {
      request: JSON.stringify(bodies.stop),
      worktree: '/wrong-tree',
    }),
  ).toThrow();
  expect(() => parseHuddleCommand(['runtime', session], { name: 'wrong-name' })).toThrow();
  expect(() =>
    parseHuddleCommand(['list'], { project: '1234567890', worktree: '/tree', request: '{}' }),
  ).toThrow();
});

it.each(['create', 'open'] as const)(
  'keeps %s inactive and reports a lost reply without repeating it',
  async (action) => {
    const request = vi.fn(async () => {
      throw new Error('lost');
    });
    const client = new HuddleClient(request, PROTOCOL_VERSION);
    const location = { project: '1234567890', worktree: '/explicit/tree' };
    const command = parseHuddleCommand(action === 'create' ? [action] : [action, 'b'.repeat(32)], {
      ...location,
      ...(action === 'create' ? { name: 'Custom workflow' } : {}),
    });
    await expect(runHuddleCommand(client, command, () => {})).rejects.toThrow(
      'Do not retry automatically',
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      action === 'create' ? '/definitions' : '/open',
      {
        project_id: location.project,
        worktree: location.worktree,
        ...(action === 'create' ? { name: 'Custom workflow' } : { huddle_id: 'b'.repeat(32) }),
      },
    );
  },
);

it('advertises effectful MCP tools honestly, rejects overrides and preserves exact failed dispatch identity', async () => {
  const fetch = vi.fn(async () => {
    throw new Error('lost reply ' + 'x'.repeat(20_000));
  });
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
      isError?: boolean;
      content?: Array<{ text: string }>;
    };
  }> = [];
  output.on('data', (bytes) => replies.push(JSON.parse(String(bytes))));
  const server = serveMcp(connection(), input, output);
  for (const message of [
    { id: 1, method: 'initialize' },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    {
      id: 3,
      method: 'tools/call',
      params: {
        name: 'huddle_stop',
        arguments: { session_id: session, request: { target }, action: 'run' },
      },
    },
    {
      id: 4,
      method: 'tools/call',
      params: { name: 'huddle_run', arguments: { session_id: session, request: bodies.run } },
    },
  ])
    input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  input.end();
  await server;
  const tools = replies.find((reply) => reply.id === 2)!.result.tools!;
  expect(tools.find((tool) => tool.name === 'huddle_run')?.annotations).toMatchObject({
    readOnlyHint: false,
    idempotentHint: false,
  });
  expect(tools.find((tool) => tool.name === 'huddle_history')?.annotations.readOnlyHint).toBe(true);
  expect(tools.some((tool) => 'action' in tool)).toBe(false);
  for (const id of [3, 4])
    expect(replies.find((reply) => reply.id === id)?.result.isError).toBe(true);
  expect(replies.find((reply) => reply.id === 4)!.result.content![0]!.text).toContain(
    'Do not retry automatically',
  );
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(`/sessions/${session}/run`),
    expect.objectContaining({ body: JSON.stringify(bodies.run) }),
  );
});
