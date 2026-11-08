import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  huddleDefinitionSchema,
  huddleEventSchema,
  type HuddleEvent,
  type HuddleLedgerIdentity,
} from '@puddle/shared';
import { HuddleLedger } from '../../../src/runtime/huddle/state/ledger.js';

export function huddleLedgerFixture(limits?: { bytes?: number; records?: number }) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-huddle-ledger-'));
  const identity: HuddleLedgerIdentity = {
    hostId: 'fixture-host',
    profileId: '0123456789',
    projectId: 'abcdef1234',
    huddleId: randomBytes(16).toString('hex'),
    sessionId: randomUUID(),
    runtimeId: randomUUID(),
  };
  let ledger = new HuddleLedger(home, identity, limits);
  const settings = huddleDefinitionSchema.shape.execution.parse({});
  const event = (override: Partial<HuddleEvent> = {}) =>
    huddleEventSchema.parse({
      format: 1,
      id: randomUUID(),
      source: { node: 'run', component: 'puddle.trigger.manual', version: 1 },
      port: 'event',
      observedAt: new Date().toISOString(),
      scope: identity,
      revision: 'a'.repeat(64),
      executionId: randomUUID(),
      data: { task: 'fixture' },
      ...override,
    });
  return {
    home,
    identity,
    settings,
    event,
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = new HuddleLedger(home, identity, limits);
      return ledger;
    },
    cleanup() {
      ledger.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
export type HuddleLedgerFixture = ReturnType<typeof huddleLedgerFixture>;

export function runningHuddleInvocation(fixture: HuddleLedgerFixture) {
  const event = fixture.event();
  const accepted = fixture.ledger.executions.accept(event, null, 1, fixture.settings);
  fixture.ledger.executions.start(accepted.execution.id);
  const input = {
    id: randomUUID(),
    executionId: accepted.execution.id,
    revision: event.revision,
    node: 'coder',
    activation: 'seed',
    iteration: 0,
    inputs: { request: event.data },
  };
  fixture.ledger.invocations.queue(input);
  return {
    event,
    execution: accepted.execution,
    invocation: fixture.ledger.invocations.start(input.id),
  };
}
