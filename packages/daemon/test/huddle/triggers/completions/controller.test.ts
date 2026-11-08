import { afterEach, expect, it } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES } from '@puddle/shared';
import { completionSourceFixture } from '../../../helpers/huddle/completion-source.js';
import { HuddleCompletionController } from '../../../../src/runtime/huddle/triggers/completions/controller.js';

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

it('charges subscription and admission memory separately, retaining progress on refusal', () => {
  const f = completionSourceFixture();
  cleanups.push(f.base.cleanup);
  let used = 0,
    allowed = true,
    guarded = 0;
  const controller = new HuddleCompletionController(
    f.base.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    () => {
      guarded++;
    },
    {
      reserve(bytes) {
        if (!allowed) return null;
        used += bytes;
        return () => {
          used -= bytes;
        };
      },
    },
  );
  cleanups.push(() => controller.stop());
  allowed = false;
  expect(() => controller.refresh([f.baseline])).toThrow('memory capacity');
  expect(controller.list()).toEqual([]);
  expect(used).toBe(0);
  allowed = true;
  controller.refresh([f.baseline]);
  const subscriptionBytes = used;
  expect(subscriptionBytes).toBeGreaterThan(0);
  const source = controller.list()[0]!;
  const page = {
    state: 'events' as const,
    cursor: { ...f.baseline.cursor, sequence: 11 },
    head: 11,
    persistencePending: false,
    records: [f.record(11)],
  };
  allowed = false;
  expect(() => controller.accept(source, page)).toThrow('memory capacity');
  expect(controller.list()[0]).toEqual(source);
  expect(f.base.ledger.page('executions')).toEqual([]);
  allowed = true;
  expect(controller.accept(source, page)).toBe(1);
  expect(used).toBe(subscriptionBytes);
  expect(guarded).toBe(4);
  controller.stop();
  expect(controller.list()).toEqual([]);
  expect(used).toBe(0);
  expect(() => controller.accept(source, page)).toThrow('not active');
});

it('rejects a missing capability or moved definition before mutating the retained activation', () => {
  const f = completionSourceFixture();
  cleanups.push(f.base.cleanup);
  const { completionEvents: _, ...old } = HUDDLE_RUNTIME_CAPABILITIES;
  const oldController = new HuddleCompletionController(f.base.ledger, f.store, old, () => {});
  expect(() => oldController.validate(f.snapshot, f.activation, [f.baseline])).toThrow(
    'does not support',
  );
  const controller = new HuddleCompletionController(
    f.base.ledger,
    f.store,
    HUDDLE_RUNTIME_CAPABILITIES,
    () => {
      throw new Error('Definition moved');
    },
  );
  const before = f.base.ledger.activations.current();
  expect(() => controller.validate(f.snapshot, f.activation, [f.baseline])).toThrow(
    'Definition moved',
  );
  expect(f.base.ledger.activations.current()).toEqual(before);
});
