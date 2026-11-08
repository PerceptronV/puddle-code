import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { HuddleRevisionController } from '../../../src/runtime/huddle/control/revisions.js';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { revisionFixture } from '../../helpers/huddle/revisions.js';

const fixtures: HuddleLedgerFixture[] = [];
function setup(records?: number) {
  const f = huddleLedgerFixture(records === undefined ? undefined : { records });
  fixtures.push(f);
  const store = new HuddleRevisionStore(f.home, f.identity.runtimeId, f.identity.huddleId);
  const controller = () => new HuddleRevisionController(f.ledger, store);
  const snapshot = revisionFixture(f);
  const input = (answer = 42) => ({
    id: randomUUID(),
    worktree: f.home,
    variables: { answer },
    bindings: {},
  });
  return { f, store, snapshot, controller, input };
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe('durable revision activation and execution bindings', () => {
  it('pins each queued execution to its original source and variables across apply/reopen', () => {
    const { f, snapshot, controller, input } = setup();
    const first = controller().apply(snapshot, input(7), 0);
    expect(first.control.state).toBe('stopped');
    f.ledger.activations.setIntent(1, 'armed', true);
    const a = f.event({ revision: snapshot.digest });
    f.ledger.executions.accept(
      a,
      null,
      1,
      snapshot.definition.execution,
      Date.now(),
      first.activation.id,
    );
    const second = controller().apply(snapshot, input(9), 2);
    const b = f.event({ revision: snapshot.digest });
    f.ledger.executions.accept(
      b,
      1,
      2,
      snapshot.definition.execution,
      Date.now(),
      second.activation.id,
    );
    const next = revisionFixture(f, 'Another revision');
    controller().apply(next, input(11), 3);
    f.reopen();
    expect(controller().forExecution(a.executionId).activation.variables).toEqual({ answer: 7 });
    expect(controller().forExecution(b.executionId).activation.variables).toEqual({ answer: 9 });
    expect(controller().forExecution(a.executionId).snapshot.digest).toBe(snapshot.digest);
    expect(f.ledger.executions.start(a.executionId).state).toBe('running');
  });

  it('observes an old repeated apply without rewinding current activation and rejects reused ids', () => {
    const { f, snapshot, controller, input } = setup();
    const old = input(7);
    controller().apply(snapshot, old, 0);
    const latest = controller().apply(snapshot, input(9), 1);
    const repeat = controller().apply(snapshot, old, 0);
    expect(repeat.duplicate).toBe(true);
    expect(repeat.control.activationId).toBe(latest.activation.id);
    expect(() => controller().apply(snapshot, { ...old, variables: { answer: 100 } }, 0)).toThrow(
      'conflicts',
    );
    expect(() => controller().apply(snapshot, input(), 0)).toThrow('control changed');
    expect(f.ledger.activations.current().generation).toBe(2);
  });

  it('refuses unarmed/stale admissions and fences queued dispatch after interruption', () => {
    const { f, snapshot, controller, input } = setup();
    expect(() => f.ledger.activations.setIntent(0, 'armed', false)).toThrow('Activate');
    const { activation } = controller().apply(snapshot, input(), 0);
    const event = f.event({ revision: snapshot.digest });
    const accept = () =>
      f.ledger.executions.accept(
        event,
        null,
        1,
        snapshot.definition.execution,
        Date.now(),
        activation.id,
      );
    expect(accept).toThrow('not armed');
    f.ledger.activations.setIntent(1, 'armed', true);
    accept();
    f.ledger.activations.setIntent(2, 'interrupted', true);
    expect(() => f.ledger.executions.start(event.executionId)).toThrow('not armed');
    expect(accept().duplicate).toBe(true);
    expect(() => f.ledger.activations.setIntent(2, 'armed', true)).toThrow('control changed');
  });

  it('leaves published source inactive when the activation transaction cannot commit', () => {
    const { f, store, snapshot, controller, input } = setup(1);
    expect(() => controller().apply(snapshot, input(), 0)).toThrow('capacity');
    expect(store.read(snapshot.digest).digest).toBe(snapshot.digest);
    expect(f.ledger.page('revision-activations')).toHaveLength(0);
    expect(f.ledger.activations.current()).toMatchObject({
      generation: 0,
      activationId: null,
      state: 'stopped',
    });
  });

  it('validates settings, explicit source worktrees and resource binding names before activation', () => {
    const { f, snapshot, controller, input } = setup();
    expect(() => controller().apply(snapshot, { ...input(), worktree: '.' }, 0)).toThrow(
      'explicit and absolute',
    );
    expect(() =>
      controller().apply(snapshot, { ...input(), variables: { missing: true } }, 0),
    ).toThrow('Unknown huddle variable');
    expect(() =>
      controller().apply(
        snapshot,
        { ...input(), bindings: { result: { account: 'invented' } } },
        0,
      ),
    ).toThrow('declared resource');
    expect(f.ledger.activations.current().activationId).toBeNull();
  });
});
