import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  huddleDocumentSchema,
  huddleRevisionContent,
  huddleSourceMcpTools,
} from '@puddle/shared';
import { HuddleSourceClient } from '../../../src/huddle/source/client.js';
import { parseHuddleCommand, runHuddleCommand } from '../../../src/huddle/commands.js';
import { PuddlangClient } from '../../../src/puddlang/client.js';
import { serveMcp } from '../../../src/puddlang/mcp.js';
import type { ConnectionAuthority } from '../../../src/lib/auth/connection-authority.js';

afterEach(() => vi.unstubAllGlobals());
const target = {
  project_id: '1234567890',
  worktree: '/host/project space?&/#',
  huddle_id: 'a'.repeat(32),
};
const content = JSON.stringify({
  format: 1,
  id: target.huddle_id,
  name: 'Source',
  nodes: [],
  edges: [],
});
function source(text = content) {
  const files = { 'huddle.json': text };
  return {
    files,
    document: huddleDocumentSchema.parse({
      digest: createHash('sha256').update(huddleRevisionContent(files, {})).digest('hex'),
      definition: JSON.parse(text),
      components: {},
      diagnostics: [],
    }),
  };
}
const input = {
  ...target,
  expected_digest: source().document.digest,
  edit: { file: 'huddle.json' as const, content },
};
const connected = (protocol = PROTOCOL_VERSION as { major: number; minor: number }) =>
  new PuddlangClient(
    () => 23456,
    { credential: () => 'fixture-authority' } as ConnectionAuthority,
    'abcdef1234',
    protocol,
  );

it('routes explicit captured reads and exact-text saves through the selected authority without extra calls', async () => {
  const fetch = vi.fn(async () => Response.json(source()));
  vi.stubGlobal('fetch', fetch);
  const client = connected();
  const print = vi.fn();
  const options = { project: target.project_id, worktree: target.worktree };
  await runHuddleCommand(
    client.huddles,
    parseHuddleCommand(['source', target.huddle_id], options),
    print,
  );
  await runHuddleCommand(
    client.huddles,
    parseHuddleCommand(['save-source', target.huddle_id], {
      ...options,
      request: JSON.stringify({ expected_digest: input.expected_digest, edit: input.edit }),
    }),
    print,
  );
  expect(print).toHaveBeenNthCalledWith(1, source());
  expect(print).toHaveBeenNthCalledWith(2, source());
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  const url = new URL(calls[0]![0]);
  expect(url.pathname).toBe(`/api/huddle/abcdef1234/definitions/${target.huddle_id}/source`);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    project_id: target.project_id,
    worktree: target.worktree,
  });
  expect(calls[0]![1].method).toBe('GET');
  expect(calls[1]![1]).toMatchObject({
    method: 'PUT',
    headers: { authorization: 'Bearer fixture-authority' },
  });
  const { huddle_id: _, ...body } = input;
  expect(JSON.parse(String(calls[1]![1].body))).toEqual(body);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects unknown fields, unsupported source and substituted CLI scope before dispatch', async () => {
  const request = vi.fn();
  const client = new HuddleSourceClient(request, PROTOCOL_VERSION);
  for (const edit of [
    { file: '../other', content },
    { file: 'huddle.json', content: content.replace('"format":1', '"format":2') },
    { file: 'huddle.json', content: content.replace('"format":1', '"future":true,"format":1') },
    { file: 'huddle.json', content, force: true },
  ])
    await expect(client.save({ ...input, edit } as typeof input)).rejects.toThrow();
  for (const request of [
    { ...input },
    { expected_digest: input.expected_digest, edit: input.edit, host_id: 'other' },
  ])
    expect(() =>
      parseHuddleCommand(['save-source', target.huddle_id], {
        project: target.project_id,
        worktree: target.worktree,
        request: JSON.stringify(request),
      }),
    ).toThrow();
  for (const protocol of [
    { major: 28, minor: 10 },
    { major: 29, minor: 0 },
  ]) {
    const older = new HuddleSourceClient(request, protocol);
    await expect(older.read(target)).rejects.toThrow('28.11');
    await expect(older.save(input)).rejects.toThrow('28.11');
  }
  expect(request).not.toHaveBeenCalled();
});

it('rejects mismatched source, metadata, digest and post-publication edits without retry', async () => {
  const good = source();
  for (const bad of [
    { ...good, files: { 'huddle.json': content + '\n' } },
    {
      ...good,
      document: { ...good.document, definition: { ...good.document.definition, name: 'Other' } },
    },
    { ...good, document: { ...good.document, digest: 'f'.repeat(64) } },
    { ...good, document: { ...good.document, layout: { format: 1, nodes: {} } } },
  ]) {
    const request = vi.fn(async () => bad);
    await expect(new HuddleSourceClient(request, PROTOCOL_VERSION).read(target)).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  }
  for (const outcome of [source(content + '\n'), new Error('Connection closed')]) {
    const request = vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    await expect(new HuddleSourceClient(request, PROTOCOL_VERSION).save(input)).rejects.toThrow(
      'Do not retry automatically',
    );
    expect(request).toHaveBeenCalledOnce();
  }
});

it.each([10, 11])('gates and dispatches source MCP tools at host 28.%s', async (minor) => {
  const fetch = vi.fn(async () => Response.json(source()));
  vi.stubGlobal('fetch', fetch);
  const inputStream = new PassThrough(),
    output = new PassThrough();
  const replies: Array<{
    id: number;
    result: { tools?: Array<{ name: string }>; isError?: boolean };
  }> = [];
  output.on('data', (data) => replies.push(JSON.parse(String(data))));
  const done = serveMcp(connected({ major: 28, minor }), inputStream, output);
  for (const message of [
    { id: 1, method: 'initialize' },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'huddle_source', arguments: target } },
    { id: 4, method: 'tools/call', params: { name: 'huddle_save_source', arguments: input } },
  ])
    inputStream.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  inputStream.end();
  await done;
  const tools = replies.find((reply) => reply.id === 2)!.result.tools!;
  expect(tools.some((tool) => tool.name === 'huddle_source')).toBe(minor === 11);
  expect(tools.some((tool) => tool.name === 'huddle_save_source')).toBe(minor === 11);
  expect(replies.find((reply) => reply.id === 3)!.result.isError ?? false).toBe(minor < 11);
  expect(replies.find((reply) => reply.id === 4)!.result.isError ?? false).toBe(minor < 11);
  expect(fetch).toHaveBeenCalledTimes(minor === 11 ? 2 : 0);
  expect(huddleSourceMcpTools[1].annotations).toMatchObject({
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
  });
});
