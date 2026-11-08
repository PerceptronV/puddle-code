import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseHuddleRetainedRevision } from '../../src/index.js';
const owner = { runtimeId: randomUUID(), incarnation: randomUUID() };
const revision = 'a'.repeat(64);
const input = { owner, revision, entry: { kind: 'file' as const, path: 'huddle.json' } };
const value = {
  source: 'retained-revision',
  observed_at: new Date().toISOString(),
  owner,
  revision,
  activation: null,
  saved: null,
  entries: [],
  content: { entry: input.entry, before: '{}', after: null },
};
it('binds recorded reads to exact owner, revision, saved digest and selected entry', () => {
  expect(parseHuddleRetainedRevision(input, value)).toEqual(value);
  for (const change of [
    { owner: { ...owner, incarnation: randomUUID() } },
    { revision: 'b'.repeat(64) },
    { content: { ...value.content, entry: { kind: 'file', path: 'other.ts' } } },
    { saved: { digest: revision, diagnostics: [] } },
  ])
    expect(() => parseHuddleRetainedRevision(input, { ...value, ...change })).toThrow();
  expect(() =>
    parseHuddleRetainedRevision({ ...input, expected_digest: revision }, value),
  ).toThrow();
});
it('requires recorded activation only for a last-activation request and does not invent historical settings', () => {
  const activation = {
    id: randomUUID(),
    revision,
    variables: {},
    bindings: {},
    worktree: '/fixture',
    appliedAt: 1,
  };
  expect(parseHuddleRetainedRevision({ owner }, { ...value, activation }).activation).toEqual(
    activation,
  );
  expect(() => parseHuddleRetainedRevision({ owner }, value)).toThrow();
  expect(() => parseHuddleRetainedRevision(input, { ...value, activation })).toThrow();
  expect(() =>
    parseHuddleRetainedRevision(
      { owner },
      { ...value, activation: { ...activation, revision: 'b'.repeat(64) } },
    ),
  ).toThrow();
});
