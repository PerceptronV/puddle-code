import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { serveMcp } from '../../../src/puddlang/mcp.js';
import { parseHuddleCommand } from '../../../src/huddle/commands.js';
import { readHuddleAuthoring } from '@puddle/shared';

it('parses local authoring without project/worktree and rejects scope and excess arguments', () => {
  expect(parseHuddleCommand(['authoring'], {})).toEqual({ action: 'authoring', input: {} });
  expect(parseHuddleCommand(['authoring', 'README.md'], {})).toEqual({
    action: 'authoring',
    input: { path: 'README.md' },
  });
  for (const options of [
    { project: 'project' },
    { worktree: '/tree' },
    { request: '{}' },
    { name: 'name' },
  ])
    expect(() => parseHuddleCommand(['authoring'], options)).toThrow();
  expect(() => parseHuddleCommand(['authoring', 'a', 'b'], {})).toThrow();
});

it('exposes the labelled client kit over MCP without huddle/host calls and rejects extra scope', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const replies: Array<{
    id: number;
    result: {
      tools?: Array<{ name: string }>;
      content?: Array<{ text: string }>;
      isError?: boolean;
    };
  }> = [];
  output.on('data', (data: Buffer) => replies.push(JSON.parse(data.toString())));
  const client = {
    context: vi.fn(),
    start: vi.fn(),
    status: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
    outcomes: vi.fn(),
    disposeOutcome: vi.fn(),
  };
  const server = serveMcp(client, input, output);
  const send = (method: string, id?: number, params?: unknown) =>
    input.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
  send('initialize', 1);
  send('notifications/initialized');
  send('tools/list', 2);
  send('tools/call', 3, { name: 'huddle_authoring', arguments: { path: 'README.md' } });
  send('tools/call', 4, { name: 'huddle_authoring', arguments: { path: '../secret' } });
  send('tools/call', 5, { name: 'huddle_authoring', arguments: { worktree: '/tree' } });
  input.end();
  await server;
  expect(replies.find((reply) => reply.id === 2)?.result.tools).toContainEqual(
    expect.objectContaining({
      name: 'huddle_authoring',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }),
  );
  expect(JSON.parse(replies.find((reply) => reply.id === 3)!.result.content![0]!.text)).toEqual(
    readHuddleAuthoring('README.md'),
  );
  expect(replies.find((reply) => reply.id === 4)?.result.isError).toBe(true);
  expect(replies.find((reply) => reply.id === 5)?.result.isError).toBe(true);
  for (const call of Object.values(client)) expect(call).not.toHaveBeenCalled();
});
