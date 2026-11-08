import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { huddleCompletionBaselinesSchema, type HuddleCompletionBaseline } from '@puddle/shared';
import { completionSourceFixture } from '../../../helpers/huddle/completion-source.js';
import { completionDefinitions } from '../../../../src/runtime/huddle/triggers/completions/definitions.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = completionSourceFixture();
  cleanups.push(f.base.cleanup);
  return f;
}

it('requires a unique bounded baseline for every declared completion source', () => {
  const f = fixture(),
    { base } = f,
    before = base.ledger.completions.list();
  for (const baselines of [[], [f.baseline, f.baseline], [{ ...f.baseline, node: 'unrelated' }]]) {
    expect(() =>
      base.ledger.completions.initialise(f.definitions, f.activation, baselines),
    ).toThrow();
    expect(base.ledger.completions.list()).toEqual(before);
  }
  expect(
    huddleCompletionBaselinesSchema.safeParse(
      Array.from({ length: 9 }, (_, n) => ({ ...f.baseline, node: `node${n}` })),
    ).success,
  ).toBe(false);
  expect(() => base.ledger.completions.initialise([], f.activation, [])).toThrow(
    'subscriptions changed',
  );
});

it('rejects foreign owner, project, profile, worktree and placement baselines', () => {
  const f = fixture(),
    { base } = f;
  // Fresh intent permits replacement identities, but never relaxes resource scope.
  base.ledger.activations.setIntent(2, 'interrupted', false);
  base.ledger.activations.setIntent(3, 'armed', false);
  const identity = f.baseline.target.identity;
  const targets: HuddleCompletionBaseline['target'][] = [
    ...[
      { profile_id: '1111111111' },
      { project_id: '2222222222' },
      { canonical_worktree_path: '/foreign-worktree' },
      { runtime_id: base.identity.runtimeId },
    ].map((patch) => ({ ...f.baseline.target, identity: { ...identity, ...patch } })),
    { ...f.baseline.target, sessionId: randomUUID() },
    { ...f.baseline.target, sessionId: base.identity.sessionId },
  ];
  for (const target of targets) {
    expect(() =>
      base.ledger.completions.initialise(f.definitions, f.activation, [{ ...f.baseline, target }]),
    ).toThrow('scope');
    expect(base.ledger.completions.list()).toEqual([]);
  }
  // Launch placement identity is retained, not rewritten to the currently selected native fork.
  expect(identity.session_id).not.toBe(f.session);
  expect(() =>
    base.ledger.completions.initialise(f.definitions, f.activation, [f.baseline]),
  ).not.toThrow();
  expect(base.ledger.completions.list()[0]!.target.identity.session_id).toBe(identity.session_id);
});

it('binds source initialisation to retained activation content and rolls back a partial batch', () => {
  const f = fixture(),
    { base } = f;
  const altered = {
    ...f.activation,
    bindings: { run: { worktree: f.worktree, session: randomUUID() } },
  };
  expect(() => base.ledger.completions.initialise(f.definitions, altered, [f.baseline])).toThrow(
    'completion activation',
  );
  const second = base.ledger.activations.apply(
    {
      ...f.activation,
      id: randomUUID(),
      bindings: { ...f.activation.bindings, next: { worktree: f.worktree, session: f.session } },
    },
    2,
  ).activation;
  const before = base.ledger.usage();
  const definitions = [...f.definitions, { ...f.definitions[0]!, node: 'next', slot: 1 }];
  const bad = {
    ...f.baseline,
    node: 'next',
    target: { ...f.baseline.target, sessionId: randomUUID() },
  };
  expect(() => base.ledger.completions.initialise(definitions, second, [f.baseline, bad])).toThrow(
    'scope',
  );
  expect(base.ledger.usage()).toEqual(before);
  expect(base.ledger.completions.list()).toEqual([]);
  base.ledger.completions.initialise(definitions, second, [
    f.baseline,
    { ...f.baseline, node: 'next' },
  ]);
  expect(base.ledger.completions.list()).toHaveLength(2);
});

it('resolves explicit variables and rejects missing or changed resource bindings', () => {
  const f = fixture();
  const snapshot = structuredClone(f.snapshot),
    activation = structuredClone(f.activation);
  snapshot.definition.variables = {
    tree: { schema: { type: 'string' }, editor: 'worktree', required: true },
    agent: { schema: { type: 'string' }, editor: 'session', required: true },
  };
  snapshot.definition.nodes[0]!.parameters = {
    worktree: { kind: 'variable', name: 'tree' },
    session: { kind: 'variable', name: 'agent' },
  };
  expect(() => completionDefinitions(snapshot, activation)).toThrow('Missing huddle variable');
  activation.variables = { tree: f.worktree, agent: f.session };
  expect(completionDefinitions(snapshot, activation)).toEqual(f.definitions);
  activation.bindings.run!.session = randomUUID();
  expect(() => completionDefinitions(snapshot, activation)).toThrow('exact resolved');
  delete activation.bindings.run;
  expect(() => completionDefinitions(snapshot, activation)).toThrow('exact resolved');
});
