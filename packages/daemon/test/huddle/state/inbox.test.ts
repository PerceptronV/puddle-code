import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';
import { huddleLedgerFixture, type HuddleLedgerFixture } from '../../helpers/huddle/ledger.js';

const fixtures: HuddleLedgerFixture[] = [];
const setup = (limits?: { bytes?: number; records?: number }) => {
  const fixture = huddleLedgerFixture(limits);
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('durable huddle trigger inbox', () => {
  it('bounds retained payload pages by bytes and excludes cancelled queued work', () => {
    const f = setup();
    const ids: string[] = [];
    for (let index = 0; index < 7; index++) {
      const event = f.event({ data: 'x'.repeat(200_000) });
      f.ledger.executions.accept(event, index === 0 ? null : index, index + 1, f.settings);
      ids.push(event.executionId);
    }
    const first = f.ledger.page('inbox');
    expect(first.length).toBeLessThan(7);
    expect(
      first.reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0),
    ).toBeLessThanOrEqual(1024 * 1024);
    expect([...first, ...f.ledger.page('inbox', { after: first.at(-1)!.ordinal })]).toHaveLength(7);
    expect(() => f.ledger.executions.finish(ids[0]!, 'completed')).toThrow('unstarted');
    f.ledger.interrupt(ids[0]!, 'cancelled', 'Stopped before dispatch');
    expect(f.ledger.page('inbox', { state: 'cancelled' })).toHaveLength(1);
    expect(() => f.ledger.executions.start(ids[0]!)).toThrow('again');
  });
  it('commits event, execution and cursor together and deduplicates after reopen without rewinding', () => {
    const f = setup();
    const first = f.event();
    const admitted = f.ledger.executions.accept(first, null, 1, f.settings);
    const second = f.event();
    f.ledger.executions.accept(second, 1, 2, f.settings);
    f.reopen();
    const duplicate = f.ledger.executions.accept(
      { ...first, executionId: randomUUID(), observedAt: new Date().toISOString() },
      null,
      1,
      f.settings,
    );
    expect(duplicate).toMatchObject({
      sequence: admitted.sequence,
      duplicate: true,
      execution: { id: first.executionId },
    });
    expect(f.ledger.executions.cursor(f.ledger.executions.sourceKey(first))).toBe(2);
    expect(f.ledger.page('executions')).toHaveLength(2);
    expect(() =>
      f.ledger.executions.accept({ ...first, data: 'changed' }, null, 1, f.settings),
    ).toThrow('conflicts');
  });

  it('rolls back cursor and execution when admission exceeds capacity', () => {
    const f = setup({ records: 4 });
    const first = f.event();
    f.ledger.executions.accept(first, null, 1, f.settings);
    const before = f.ledger.usage();
    const second = f.event();
    expect(() => f.ledger.executions.accept(second, 1, 2, f.settings)).toThrow('capacity');
    expect(f.ledger.usage()).toEqual(before);
    expect(f.ledger.executions.cursor(f.ledger.executions.sourceKey(first))).toBe(1);
    expect(() => f.ledger.executions.get(second.executionId)).toThrow('does not exist');
    f.reopen();
    expect(f.ledger.page('inbox')).toHaveLength(1);
  });

  it('rejects stale cursors, forged scope and reused execution ids without writes', () => {
    const f = setup();
    const first = f.event();
    f.ledger.executions.accept(first, null, 1, f.settings);
    const usage = f.ledger.usage();
    expect(() => f.ledger.executions.accept(f.event(), null, 2, f.settings)).toThrow(
      'cursor changed',
    );
    expect(() =>
      f.ledger.executions.accept(
        f.event({ scope: { ...f.identity, profileId: '1111111111' } }),
        1,
        2,
        f.settings,
      ),
    ).toThrow('scope');
    expect(() =>
      f.ledger.executions.accept(f.event({ executionId: first.executionId }), 1, 2, f.settings),
    ).toThrow('already in use');
    expect(f.ledger.usage()).toEqual(usage);
  });

  it('retains daily and concurrency budgets through reopen and refuses expired execution', () => {
    const f = setup();
    const now = Date.now();
    const event = f.event();
    const settings = { ...f.settings, maxDailyExecutions: 2, timeoutMs: 1000 };
    f.ledger.executions.accept(event, null, 1, settings, now);
    f.ledger.executions.start(event.executionId, now);
    const second = f.event();
    f.ledger.executions.accept(second, 1, 2, settings, now);
    expect(() => f.ledger.executions.start(second.executionId, now)).toThrow('concurrency');
    f.reopen();
    expect(() => f.ledger.executions.accept(f.event(), 2, 3, settings, now)).toThrow(
      'daily execution',
    );
    expect(() => f.ledger.executions.start(second.executionId, now + 1000)).toThrow('deadline');
    expect(() => f.ledger.executions.start(event.executionId, now)).toThrow('again');
  });

  it('excludes another writer and refuses identity changes on the existing ledger', () => {
    const f = setup();
    expect(() => new HuddleLedger(f.home, f.identity)).toThrow('Another live process');
    f.ledger.close();
    expect(() => new HuddleLedger(f.home, { ...f.identity, projectId: '1111111111' })).toThrow(
      'identity changed',
    );
    f.reopen();
    expect(f.ledger.page('inbox')).toEqual([]);
  });
});
