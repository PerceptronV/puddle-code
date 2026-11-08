import { expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, huddleReviewSchema } from '@puddle/shared';
import { HuddleClient } from '../../src/huddle/client.js';
import { parseHuddleCommand, runHuddleCommand } from '../../src/huddle/commands.js';
import { callHuddleExecutionTool, executionTools } from '../../src/huddle/execution/mcp.js';
const session = '00000000-0000-4000-8000-000000000001';
const target = {
  runtimeId: '00000000-0000-4000-8000-000000000002',
  incarnation: '00000000-0000-4000-8000-000000000003',
  generation: 5,
  activationId: '00000000-0000-4000-8000-000000000004',
};
const digest = 'a'.repeat(64);
const entry = { kind: 'file' as const, path: 'nodes/example/run.ts' };
const review = huddleReviewSchema.parse({
  target,
  active: {
    id: target.activationId,
    revision: 'b'.repeat(64),
    worktree: '/chosen/worktree',
    variables: { worktree: '/other/declared/tree' },
    bindings: { worker: { worktree: '/other/declared/tree' } },
    appliedAt: 10,
  },
  saved: null,
  entries: [],
  content: { entry, before: 'active source', after: null },
});
it.each(['revision', 'diff'] as const)(
  'sends one exact %s request and prints retained source without mutation',
  async (action) => {
    const input = { target, entry, ...(action === 'diff' ? { expected_digest: digest } : {}) };
    const reply = { ...review, saved: action === 'diff' ? { digest, diagnostics: [] } : null };
    const request = vi.fn(async () => reply);
    const client = new HuddleClient(request, PROTOCOL_VERSION);
    const print = vi.fn();
    expect(
      await runHuddleCommand(
        client,
        parseHuddleCommand([action, session], { request: JSON.stringify(input) }),
        print,
      ),
    ).toBe(0);
    expect(request).toHaveBeenCalledExactlyOnceWith(`/sessions/${session}/${action}`, input);
    expect(print).toHaveBeenCalledExactlyOnceWith(reply);
    const tool = executionTools(client.execution).find((tool) => tool.name === `huddle_${action}`)!;
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(
      await callHuddleExecutionTool(client.execution, tool.name, {
        session_id: session,
        request: input,
      }),
    ).toEqual(reply);
  },
);
it('gates review at 28.10 without hiding older runtime tools', async () => {
  const request = vi.fn();
  const client = new HuddleClient(request, { major: 28, minor: 9 });
  expect(executionTools(client.execution).some((tool) => tool.name === 'huddle_run')).toBe(true);
  expect(
    executionTools(client.execution).some((tool) =>
      ['huddle_diff', 'huddle_revision'].includes(tool.name),
    ),
  ).toBe(false);
  await expect(
    client.execution.execute({ action: 'revision', session_id: session, request: { target } }),
  ).rejects.toThrow('28.10');
  expect(request).not.toHaveBeenCalled();
});
it.each([
  ['revision', {}],
  ['diff', { target }],
  ['revision', { target, expected_digest: digest }],
  ['diff', { target, expected_digest: digest, entry: { kind: 'file', path: '../escape' } }],
])('validates reviewed %s fields before connection', (action, request) => {
  expect(() =>
    parseHuddleCommand([String(action), session], { request: JSON.stringify(request) }),
  ).toThrow();
});
it.each([
  { ...review, target: { ...target, generation: 6 } },
  { ...review, saved: { digest, diagnostics: [] } },
  { ...review, active: { ...review.active, id: session } },
  { ...review, content: { ...review.content, entry: { kind: 'file', path: 'other.ts' } } },
])('refuses substituted revision evidence', async (value) => {
  const request = vi.fn(async () => value);
  const client = new HuddleClient(request, PROTOCOL_VERSION);
  await expect(
    client.execution.execute({
      action: 'revision',
      session_id: session,
      request: { target, entry },
    }),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});
it('does not refresh a stale digest or retry a failed read', async () => {
  const request = vi.fn(async () => {
    throw new Error('huddle_source_changed');
  });
  const client = new HuddleClient(request, PROTOCOL_VERSION);
  await expect(
    client.execution.execute({
      action: 'diff',
      session_id: session,
      request: { target, expected_digest: digest },
    }),
  ).rejects.toThrow('huddle_source_changed');
  expect(request).toHaveBeenCalledOnce();
});
