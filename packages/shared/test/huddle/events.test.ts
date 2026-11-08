import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  huddleDeliveryResultSchema,
  huddleDeliverySchema,
  huddleEventSchema,
  huddleTriggerEmissionSchema,
  huddleTriggerHealthSchema,
} from '../../src/api/huddle/events.js';
import { huddleFixtureId } from '../helpers/huddle.js';

function event() {
  return {
    format: 1,
    id: 'provider-event-1',
    source: { node: 'agent', component: 'puddle.trigger.turn', version: 1 },
    port: 'completed',
    observedAt: '2026-11-08T00:00:00Z',
    scope: {
      hostId: 'local',
      profileId: '0123456789',
      projectId: 'abcdef1234',
      huddleId: huddleFixtureId,
      sessionId: randomUUID(),
      runtimeId: randomUUID(),
    },
    revision: 'a'.repeat(64),
    executionId: randomUUID(),
    resource: {
      kind: 'turn',
      worktree: '/srv/project',
      sessionId: randomUUID(),
      runtimeId: randomUUID(),
      segmentId: randomUUID(),
      turn: 1,
      nativeRef: 'native-thread',
    },
    data: { reply: 'done' },
  };
}

describe('huddle event and delivery contracts', () => {
  it('requires complete turn/resource identity rather than status-only completion', () => {
    const value = event();
    expect(huddleEventSchema.parse(value).resource?.kind).toBe('turn');
    for (const key of ['worktree', 'sessionId', 'runtimeId', 'segmentId', 'turn', 'nativeRef']) {
      const resource = Object.fromEntries(
        Object.entries(value.resource).filter(([name]) => name !== key),
      );
      expect(huddleEventSchema.safeParse({ ...value, resource }).success).toBe(false);
    }
  });

  it('lets extensions supply events/cursors but not choose host authority or execution identity', () => {
    const value = { id: 'tick-1', port: 'event', data: null, nextCursor: { tick: 1 } };
    expect(huddleTriggerEmissionSchema.parse(value)).toEqual(value);
    expect(huddleTriggerEmissionSchema.safeParse({ ...value, scope: event().scope }).success).toBe(
      false,
    );
    expect(
      huddleTriggerEmissionSchema.safeParse({ ...value, executionId: randomUUID() }).success,
    ).toBe(false);
  });

  it('distinguishes unknown delivery from success and requires exact causal context', () => {
    const delivery = {
      format: 1,
      id: randomUUID(),
      idempotencyKey: 'b'.repeat(64),
      event: event(),
      invocationId: randomUUID(),
      node: 'report',
      port: 'input',
      data: 'report',
    };
    expect(huddleDeliverySchema.parse(delivery).event.revision).toBe('a'.repeat(64));
    expect(huddleDeliverySchema.safeParse({ ...delivery, idempotencyKey: undefined }).success).toBe(
      false,
    );
    expect(
      huddleDeliveryResultSchema.parse({ status: 'unknown', message: 'Reply lost' }).status,
    ).toBe('unknown');
    expect(huddleDeliveryResultSchema.safeParse({ status: 'delivered' }).success).toBe(false);
    expect(
      huddleDeliveryResultSchema.parse({ status: 'delivered', receipt: { id: 'remote-1' } }).status,
    ).toBe('delivered');
    expect(huddleTriggerHealthSchema.safeParse({ state: 'gap' }).success).toBe(false);
    expect(
      huddleTriggerHealthSchema.parse({
        state: 'gap',
        message: 'Source retention expired',
        after: 42,
      }).state,
    ).toBe('gap');
  });
});
