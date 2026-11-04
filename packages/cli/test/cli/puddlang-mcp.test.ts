import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { serveMcp } from '../../src/puddlang/mcp.js';
import type { PuddlangClient } from '../../src/puddlang/client.js';

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<Record<string, unknown>> = [];
  output.on('data', (data: Buffer) => replies.push(JSON.parse(data.toString())));
  const client = {
    context: vi.fn(async () => ({
      profile: { id: '1234567890', name: 'work' },
      projects: [],
      accounts: [],
      agents: [],
    })),
    start: vi.fn<PuddlangClient['start']>(),
    status: vi.fn<PuddlangClient['status']>(),
    events: vi.fn<PuddlangClient['events']>(),
    cancel: vi.fn<PuddlangClient['cancel']>(),
    outcomes: vi.fn<PuddlangClient['outcomes']>(),
    disposeOutcome: vi.fn<PuddlangClient['disposeOutcome']>(),
  };
  const send = (method: string, id?: number, params?: unknown) =>
    input.write(JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n');
  return { input, output, replies, client, send };
}
describe('puddlang MCP stdio', () => {
  it('negotiates capabilities, lists schemas and calls the profile-bound client', async () => {
    const f = fixture();
    const server = serveMcp(f.client, f.input, f.output);
    f.send('initialize', 1, {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    f.send('notifications/initialized');
    f.send('tools/list', 2);
    f.send('tools/call', 3, { name: 'puddlang_context', arguments: {} });
    f.input.end();
    await server;
    expect(f.replies[0]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    expect(f.replies[1]).toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: 'puddlang_run' })]),
      },
    });
    expect(f.client.context).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.replies[2])).toContain('work');
  });
  it('rejects uninitialised calls and invalid inputs without submitting work', async () => {
    const f = fixture();
    const server = serveMcp(f.client, f.input, f.output);
    f.send('tools/list', 1);
    f.send('initialize', 2);
    f.send('notifications/initialized');
    f.send('tools/call', 3, { name: 'puddlang_run', arguments: { source: 'export default 1' } });
    f.input.end();
    await server;
    expect(f.replies[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(f.replies[2]).toMatchObject({ id: 3, result: { isError: true } });
    expect(f.client.start).not.toHaveBeenCalled();
  });
  it('rejects an oversized unterminated input line', async () => {
    const f = fixture();
    const server = serveMcp(f.client, f.input, f.output);
    f.input.end('x'.repeat(1024 * 1024 + 1));
    await expect(server).rejects.toThrow('1 MiB');
  });
  it('requires an explicit exact read/discard request and forwards inspection separately', async () => {
    const f = fixture();
    f.client.outcomes.mockResolvedValue({ outcomes: [], next_after: null });
    const server = serveMcp(f.client, f.input, f.output);
    const id = '00000000-0000-4000-8000-000000000001';
    f.send('initialize', 1);
    f.send('notifications/initialized');
    f.send('tools/call', 2, { name: 'puddlang_outcomes', arguments: { id, after: 7 } });
    f.send('tools/call', 3, {
      name: 'puddlang_outcome',
      arguments: { id, operation: 8, action: 'discard' },
    });
    f.send('tools/call', 4, {
      name: 'puddlang_outcome',
      arguments: { id, operation: 8, action: 'discard', fingerprint: 'a'.repeat(64) },
    });
    f.input.end();
    await server;
    expect(f.client.outcomes).toHaveBeenCalledWith(id, 7);
    expect(f.client.disposeOutcome).toHaveBeenCalledExactlyOnceWith(id, 8, {
      action: 'discard',
      fingerprint: 'a'.repeat(64),
    });
    expect(f.replies.find((reply) => reply.id === 3)).toMatchObject({ result: { isError: true } });
  });
});
